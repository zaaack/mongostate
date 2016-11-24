const mongoose = require('mongoose');
mongoose.Promise = Promise;
const Schema = mongoose.Schema;
const ObjectId = mongoose.Types.ObjectId;
const timestamp = require('mongoose-timestamp');
const debug = require('debug')('mongostate');
const jsondiffpatch = require('jsondiffpatch').create();

const states = {
  INIT: 'init',
  PENDING: 'pending',
  COMMITTED: 'committed',
  ROLLBACK: 'rollback',
  CANCELLED: 'cancelled'
};

const operations = {
  CREATE: 'create',
  UPDATE: 'update',
  REMOVE: 'remove'
};

const transactionSchema = new Schema({
  state: {
    type: String,
    enums: [states.INIT, states.PENDING, states.COMMITTED, states.ROLLBACK, states.CANCELLED],
    default: states.INIT,
    required: true
  },
  usedModelNames: [String],
  actions: [{
    operation: {
      type: String, required: true, enums: [
        operations.CREATE,
        operations.UPDATE,
        operations.REMOVE
      ]
    },
    model: { type: String, required: true },
    entity: { type: String, required: true },
    enableHistory: { type: Boolean, default: false }
  }],
  error: {
    message: String,
    stack: String
  },
  biz: {}
});

const lockSchema = new Schema({
  transaction: { type: Schema.ObjectId, required: true, index: true },
  model: { type: String, required: true },
  entity: { type: String, required: true }
});

lockSchema.index({ model: 1, entity: 1 }, { unique: true });

const historySchema = new Schema({
  transaction: { type: Schema.ObjectId, required: true, index: true },
  entity: { type: String, required: true, index: true },
  biz: {},
  prev: {},
  diff: {},
  reverted: { type: Boolean, default: false }
});

historySchema.virtual('current').get(function () {
  return jsondiffpatch.patch(this.prev, this.diff);
});

historySchema.set('toJSON', { virtuals: true });

if (!mongoose.plugins.some(plugin => plugin[0] === timestamp)) {
  transactionSchema.plugin(timestamp);
  lockSchema.plugin(timestamp);
  historySchema.plugin(timestamp);
}

class Transaction {
  constructor ({
    connection,
    transactionModel,
    lockModel,
    id,
    historyConnection
  }) {
    this.id = id;
    this.transactionModel = transactionModel;
    this.lockModel = lockModel;
    this.connection = connection;
    this.usedModel = {};
    this.historyConnection = historyConnection;
  }

  static getTransactionModel (connection, transactionCollectionName = 'transaction') {
    if (!connection) throw new Error('connection is required!');
    return connection.model(transactionCollectionName, transactionSchema);
  }

  static getLockModel (connection, lockCollectionName = 'lock') {
    if (!connection) throw new Error('connection is required!');
    return connection.model(lockCollectionName, lockSchema);
  }

  static * init ({
    connection,
    id,
    transactionCollectionName,
    lockCollectionName,
    historyConnection,
    biz = {}
  } = {}) {
    const transactionModel = this.getTransactionModel(connection, transactionCollectionName);
    const lockModel = this.getLockModel(connection, lockCollectionName);
    let t;
    if (id) t = yield transactionModel.findById(id);
    if (!t) {
      id = id || new ObjectId;
      yield transactionModel.create({ _id: id, biz: JSON.parse(JSON.stringify(biz)) });
    } else {
      if ([states.CANCELLED, states.COMMITTED].includes(t.state)) throw new Error(`The transaction [${t.id}] has [${t.state}].`);
    }
    return new this({
      connection,
      transactionModel,
      lockModel,
      id,
      historyConnection
    });
  }

  * 'try' (wrapper = function * () {
  }) {
    if (wrapper.constructor.name !== 'GeneratorFunction') throw new Error('wrapper should be a generator function.');
    const transaction = yield this.findTransaction();
    if (transaction.state === states.INIT) {
      yield this.transactionModel.findByIdAndUpdate(this.id, {
        $set: { state: states.PENDING }
      });
    }
    let result;
    try {
      const transaction = yield this.findTransaction();
      if (transaction.state === states.PENDING) {
        result = yield wrapper.bind(this)();
        yield this.commit();
      } else {
        yield this.cancel(new Error('Transaction is not pending!'));
      }
    } catch (err) {
      yield this.cancel(err);
      throw err;
    }
    return result;
  }

  use (Model, enableHistory = true) {
    const modelName = Model.modelName;
    const schema = Model.schema;
    schema.add({
      __t: { type: Schema.ObjectId, required: true }
    });
    const SSModel = this.connection.model(`sub_state_${modelName}`, schema);
    if (!this.usedModel[modelName]) {
      this.usedModel[modelName] = { Model, SSModel };
      this.transactionModel.findOneAndUpdate({
        _id: this.id,
        usedModelNames: { $ne: modelName }
      }, {
        $push: {
          usedModelNames: modelName
        }
      }).exec();
    }
    let History;
    if (this.historyConnection) {
      History = this.historyConnection.model(`${modelName}_history`, historySchema);
    }
    return {
      create: function * (...params) {
        return yield this.create.bind(this)(Model, SSModel, params, enableHistory);
      }.bind(this),
      findOneAndUpdate: function * (...params) {
        return yield this.findOneAndUpdate.bind(this)(Model, SSModel, params, enableHistory);
      }.bind(this),
      findByIdAndUpdate: function * (...params) {
        return yield this.findByIdAndUpdate.bind(this)(Model, SSModel, params, enableHistory);
      }.bind(this),
      findByIdAndRemove: function * (...params) {
        return yield this.findByIdAndRemove.bind(this)(Model, SSModel, params, enableHistory);
      }.bind(this),
      findOneAndRemove: function * (...params) {
        return yield this.findOneAndRemove.bind(this)(Model, SSModel, params, enableHistory);
      }.bind(this),
      findOne: function * (...params) {
        return yield this.findOne.bind(this)(Model, SSModel, params);
      }.bind(this),
      findById: function * (...params) {
        return yield this.findById.bind(this)(Model, SSModel, params);
      }.bind(this),
      findHistories: function * (...params) {
        if (!History) return [];
        return yield History.find(...params);
      },
      findLatestHistory: function * (...params) {
        if (!History) return null;
        return yield History.findOne(...params).sort({ _id: -1 });
      },
      revertTo: function * (historyId) {
        if(!Transaction.noWarning) {
          console.warn('The `revertTo` method is dangerous, only use it when you know why!');
        }
        if (!History) return null;
        const transaction = yield this.findTransaction();
        const history = yield History.findById(historyId);
        if (!history) throw new Error(`The history [${historyId}] is not exists!`);
        const doc = history.toJSON().prev;
        const prevEntity = yield Model.findById(history.entity);
        let prev;
        if (prevEntity) {
          prev = prevEntity.toJSON();
          delete prev.__v;
        }
        const diff = jsondiffpatch.diff(prev, doc);
        yield History.create({
          transaction: this.id,
          entity: history.entity,
          biz: transaction.biz,
          prev,
          diff,
          reverted: true
        });
        if (doc) {
          return yield Model.findByIdAndUpdate(history.entity, doc, { upsert: true, new: true });
        } else {
          yield Model.findByIdAndRemove(history.entity);
          return null;
        }
      }.bind(this)
    };
  }

  * create (Model, SSModel, [doc], enableHistory) {
    if (!doc._id) {
      doc._id = new ObjectId;
    } else {
      const entity = yield this.findById(Model, SSModel, [doc._id]);
      if (entity) throw new Error('entity has already exists!');
    }
    yield this.pushAction({
      operation: operations.CREATE,
      model: Model.modelName,
      entity: doc._id,
      enableHistory
    });
    yield this.lock({ id: doc._id }, Model);
    return yield this.initSubStateData(SSModel, doc);
  }

  * findOneAndUpdate (Model, SSModel, [query, doc, options], enableHistory) {
    const entity = yield this.findOne(Model, SSModel, [query]);
    if (!entity) throw new Error('Entity is not exists');
    yield this.pushAction({
      operation: operations.UPDATE,
      model: Model.modelName,
      entity: entity.id,
      enableHistory
    });
    yield this.lock(entity, Model);
    return yield SSModel.findOneAndUpdate(query, doc, options);
  }

  * findByIdAndUpdate (Model, SSModel, [id, doc, options], enableHistory) {
    return yield this.findOneAndUpdate(Model, SSModel, [{ _id: id }, doc, options], enableHistory);
  }

  * findOneAndRemove (Model, SSModel, [query], enableHistory) {
    const entity = yield this.findOne(Model, SSModel, [query]);
    yield this.pushAction({
      operation: operations.REMOVE,
      model: Model.modelName,
      entity: entity.id,
      enableHistory
    });
    yield this.lock(entity, Model);
  }

  * findByIdAndRemove (Model, SSModel, [id], enableHistory) {
    yield this.findOneAndRemove(Model, SSModel, [{ _id: id }], enableHistory);
  }

  * findOne (Model, SSModel, [criteria]) {
    const entity = yield SSModel.findOne(criteria);
    const lock = yield this.checkLock(entity, Model);
    if (lock) {
      return entity;
    }
    if (!entity) {
      const srcEntity = yield Model.findOne(criteria);
      if (srcEntity) {
        const doc = srcEntity.toJSON();
        delete doc.__v;
        yield this.initSubStateData(SSModel, doc);
      }
      return srcEntity;
    }
    return entity;
  }

  * findById (Model, SSModel, [id]) {
    return yield this.findOne(Model, SSModel, [{ _id: id }]);
  }

  * checkLock (entity, Model) {
    if (!entity) return null;
    const lock = yield this.lockModel.findOne({
      model: Model.modelName,
      entity: entity.id
    });
    if (lock && lock.transaction.toString() !== this.id.toString()) {
      throw new Error(`entity [${entity.id}] is locked by transaction [${lock.transaction}]`);
    }
    return lock;
  }

  * lock (entity, Model) {
    if (!entity) throw new Error('Entity is not exists!');
    const lock = yield this.checkLock(entity, Model);
    if (!lock) {
      yield this.lockModel.create({
        transaction: this.id,
        model: Model.modelName,
        entity: entity.id
      });
    }
  }

  * initSubStateData (SSModel, doc) {
    doc.__t = this.id;
    return yield SSModel.create(doc);
  }

  * pushAction (action) {
    yield this.transactionModel.findByIdAndUpdate(this.id, {
      $push: {
        actions: action
      }
    });
  }

  * findTransaction () {
    return yield this.transactionModel.findById(this.id);
  }

  * commit () {
    const transaction = yield this.findTransaction();
    if (transaction.state !== states.PENDING) throw new Error(`Expected the transaction [${this.id}] to be pending, but got ${transaction.state}`);

    const entitiesActivated = [];

    for (let action of transaction.actions.reverse()) {
      const { model, entity, enableHistory, operation } = action;
      if (entitiesActivated.includes(`${model}:${entity}`)) continue;
      entitiesActivated.push(`${model}:${entity}`);
      const { Model, SSModel } = this.usedModel[model] || {};
      if (!Model) throw new Error(`Model ${model} has not used, please use the model first`);
      const subStateEntity = yield SSModel.findById(entity);
      let doc;
      if (subStateEntity) {
        doc = subStateEntity.toJSON();
        delete doc.__v;
        delete doc.__t;
        delete doc.createdAt;
        delete doc.updatedAt;
      }
      // Record histories
      if (this.historyConnection && enableHistory) {
        const History = this.historyConnection.model(`${model}_history`, historySchema);
        const prevEntity = yield Model.findById(entity);
        let prev;
        if (prevEntity) {
          prev = prevEntity.toJSON();
          delete prev.__v;
        }
        const diff = jsondiffpatch.diff(prev, doc);
        yield History.create({
          transaction: this.id,
          entity,
          biz: transaction.biz,
          prev,
          diff,
        });
      }
      if (doc) {
        const doc = subStateEntity.toJSON();
        delete doc.__v;
        delete doc.__t;
        yield Model.findByIdAndUpdate(entity, doc, { upsert: true });
      } else {
        yield Model.findByIdAndRemove(entity);
      }
    }
    yield this.clearSubStateData();
    yield this.unlock();
    yield this.transactionModel.findByIdAndUpdate(this.id, {
      $set: {
        state: states.COMMITTED
      }
    });
    debug(`Transaction [${this.id}] committed!`);
  }

  * rollback () {
    const transaction = yield this.findTransaction();
    if (![states.PENDING, states.ROLLBACK].includes(transaction.state)) throw new Error(`Expected the transaction [${this.id}] to be pending/rollback, but got ${transaction.state}`);
    yield this.transactionModel.findByIdAndUpdate(this.id, {
      $set: {
        state: states.ROLLBACK
      }
    });
    yield this.clearSubStateData();
    debug(`Transaction [${this.id}] rollback success!`);
  }

  * cancel (error) {
    const transaction = yield this.findTransaction();
    if (![states.PENDING, states.ROLLBACK].includes(transaction.state)) throw new Error(`Expected the transaction [${this.id}] to be pending/rollback, but got ${transaction.state}`);
    yield this.rollback();
    yield this.unlock();
    yield this.transactionModel.findByIdAndUpdate(this.id, {
      $set: {
        state: states.CANCELLED
      },
      error: {
        message: error.message,
        stack: error.stack
      }
    });
    debug(`Transaction [${this.id}] cancelled!`);
  }

  * clearSubStateData () {
    const usedModelNames = Object.keys(this.usedModel);
    const t = yield this.findTransaction();
    if (t.usedModelNames.some(modelName => !usedModelNames.includes(modelName))) {
      throw new Error(`${t.usedModelNames} should be used first!`);
    }
    for (let modelName of usedModelNames) {
      const { SSModel } = this.usedModel[modelName];
      yield SSModel.remove({ __t: this.id });
    }
  }

  * unlock () {
    yield this.lockModel.remove({ transaction: this.id });
  }

}

module.exports = Transaction;