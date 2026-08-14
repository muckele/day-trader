const test = require('node:test');
const assert = require('node:assert/strict');
const {
  reconcileRoboOrders,
  reconcileRejectedSubmissions,
  submitMissingProtectiveStops,
  submitProtectiveStopForEntry
} = require('../robotrader/reconciliation');
const { SUBMISSION_STATES } = require('../services/submissionOutcomeService');
const { createAlpacaBroker: createRealAlpacaBroker } = require('../robotrader/alpacaBroker');

function installPaperSubmissionGuard(deps, {
  acquire = true,
  renew = true,
  unresolved = null
} = {}) {
  deps.PaperOrder = deps.PaperOrder || { findOne: async () => null };
  deps.acquireAlpacaPaperSubmissionLock = async (_accountId, owner) => (
    acquire ? { owner } : null
  );
  deps.renewAlpacaPaperSubmissionLock = async () => renew;
  deps.releaseAlpacaPaperSubmissionLock = async () => ({ matchedCount: 1 });
  deps.findUnresolvedAlpacaPaperSubmission = async () => unresolved;
  return deps;
}

test('reconciliation resolves a rejected submission only after broker 404 confirmation', async () => {
  const saved = [];
  const audits = [];
  const rejectedOrder = {
    _id: 'rejected-local-1',
    userId: 'user-1',
    broker: 'alpaca',
    environment: 'paper',
    status: 'rejected',
    submissionState: SUBMISSION_STATES.REJECTED,
    externalOrderId: null,
    clientOrderId: 'daytrader-robotrader-MSFT-rejected',
    discrepancy: 'Alpaca 422: bracket orders must be entry orders',
    save: async function save() {
      saved.push({
        reconciliationStatus: this.reconciliationStatus,
        discrepancy: this.discrepancy,
        resolution: this.reconciliationResolution,
        evidence: this.reconciliationResolutionEvidence
      });
      return this;
    }
  };
  const deps = {
    RoboTradeOrder: {
      find: () => ({ sort: () => ({ limit: async () => [rejectedOrder] }) })
    },
    RoboAuditLog: {
      create: async payload => {
        audits.push(payload);
        return payload;
      }
    }
  };
  const broker = {
    getOrderByClientOrderId: async () => {
      const err = new Error('order not found');
      err.response = { status: 404 };
      throw err;
    }
  };

  const result = await reconcileRejectedSubmissions({ mode: 'paper', broker }, deps);

  assert.deepEqual(result.resolved, ['rejected-local-1']);
  assert.equal(result.discrepancies.length, 0);
  assert.equal(saved[0].reconciliationStatus, 'resolved_rejected');
  assert.equal(saved[0].discrepancy, null);
  assert.equal(saved[0].evidence.lookupStatus, 404);
  assert.equal(audits[0].eventType, 'robotrader_reconciliation_resolved');
});

test('robotrader reconciliation updates local order status from Alpaca', async () => {
  const saved = [];
  const localOrder = {
    _id: 'local-order-1',
    userId: 'user-1',
    intentId: 'intent-1',
    decisionId: 'decision-1',
    environment: 'paper',
    externalOrderId: 'alpaca-order-1',
    clientOrderId: 'robotrader-client-1',
    qty: 1,
    status: 'accepted',
    save: async function save() {
      saved.push({ status: this.status, filledQty: this.filledQty, reconciliationStatus: this.reconciliationStatus });
      return this;
    }
  };
  const auditEvents = [];
  const intentUpdates = [];
  const decisionUpdates = [];
  const deps = {
    OrderIntent: {
      updateOne: async (query, update) => {
        intentUpdates.push({ query, update });
      }
    },
    RoboTradeDecision: {
      updateOne: async (query, update) => {
        decisionUpdates.push({ query, update });
      }
    },
    RoboTradeOrder: {
      find: () => ({
        sort: () => ({
          limit: async () => [localOrder]
        })
      }),
      findOne: async () => ({ _id: 'local-order-1' }),
      create: async payload => payload
    },
    RoboAuditLog: {
      create: async payload => {
        auditEvents.push(payload);
        return payload;
      }
    },
    createAlpacaBroker: () => ({
      getOrder: async () => ({
        id: 'alpaca-order-1',
        client_order_id: 'robotrader-client-1',
        status: 'filled',
        filled_qty: '1',
        filled_avg_price: '201.5'
      }),
      listOrders: async () => []
    })
  };

  const result = await reconcileRoboOrders({ mode: 'paper' }, deps);
  assert.equal(result.updatedCount, 1);
  assert.equal(saved[0].status, 'filled');
  assert.equal(saved[0].filledQty, 1);
  assert.equal(saved[0].reconciliationStatus, 'matched');
  assert.equal(intentUpdates[0].update.$set.status, 'filled');
  assert.equal(decisionUpdates[0].update.$set.status, 'filled');
  assert.equal(auditEvents[0].eventType, 'robotrader_order_status_changed');
});

test('robotrader reconciliation can recover orders by client order id', async () => {
  const saved = [];
  const localOrder = {
    _id: 'local-order-client-1',
    userId: 'user-1',
    environment: 'paper',
    externalOrderId: null,
    clientOrderId: 'daytrader-robotrader-AAPL-fixed',
    status: 'pending_submit',
    submissionState: SUBMISSION_STATES.UNKNOWN,
    save: async function save() {
      saved.push({
        externalOrderId: this.externalOrderId,
        status: this.status,
        submissionState: this.submissionState,
        reconciliationStatus: this.reconciliationStatus
      });
      return this;
    }
  };
  const deps = {
    RoboTradeOrder: {
      find: () => ({
        sort: () => ({
          limit: async () => [localOrder]
        })
      }),
      findOne: async () => ({ _id: 'local-order-client-1' }),
      create: async payload => payload
    },
    RoboAuditLog: {
      create: async payload => payload
    },
    createAlpacaBroker: () => ({
      getOrder: async () => {
        throw new Error('should use client order lookup');
      },
      getOrderByClientOrderId: async clientOrderId => ({
        id: 'alpaca-order-by-client-1',
        client_order_id: clientOrderId,
        status: 'accepted',
        submitted_at: '2026-05-20T12:00:00.000Z'
      }),
      listOrders: async () => []
    })
  };

  const result = await reconcileRoboOrders({ mode: 'paper' }, deps);

  assert.equal(result.updatedCount, 1);
  assert.equal(saved[0].externalOrderId, 'alpaca-order-by-client-1');
  assert.equal(saved[0].status, 'accepted');
  assert.equal(saved[0].submissionState, SUBMISSION_STATES.SUBMITTED);
  assert.equal(saved[0].reconciliationStatus, 'matched');
});

test('unresolved robotrader submission can reconcile by its original external ID alone', async () => {
  const saved = [];
  const externalLookups = [];
  const localOrder = {
    _id: 'local-order-external-only',
    userId: 'user-1',
    accountId: 'user:external-only',
    environment: 'paper',
    externalOrderId: 'alpaca-external-only',
    clientOrderId: null,
    qty: 1,
    status: 'pending_submit',
    submissionState: SUBMISSION_STATES.UNKNOWN,
    save: async function save() {
      saved.push({
        externalOrderId: this.externalOrderId,
        clientOrderId: this.clientOrderId,
        status: this.status,
        submissionState: this.submissionState,
        reconciliationStatus: this.reconciliationStatus
      });
      return this;
    }
  };
  const deps = {
    RoboTradeOrder: {
      find: () => ({
        sort: () => ({
          limit: async () => [localOrder]
        })
      }),
      findOne: async () => ({ _id: localOrder._id }),
      create: async payload => payload
    },
    RoboAuditLog: {
      create: async payload => payload
    },
    createAlpacaBroker: () => ({
      getOrder: async externalOrderId => {
        externalLookups.push(externalOrderId);
        return {
          id: externalOrderId,
          status: 'accepted',
          submitted_at: '2026-05-20T12:00:00.000Z'
        };
      },
      getOrderByClientOrderId: async () => {
        throw new Error('client-ID lookup must not run');
      },
      listOrders: async () => []
    })
  };

  const result = await reconcileRoboOrders({ mode: 'paper' }, deps);

  assert.equal(result.updatedCount, 1);
  assert.deepEqual(externalLookups, ['alpaca-external-only']);
  assert.equal(saved[0].externalOrderId, 'alpaca-external-only');
  assert.equal(saved[0].clientOrderId, null);
  assert.equal(saved[0].submissionState, SUBMISSION_STATES.SUBMITTED);
  assert.equal(saved[0].reconciliationStatus, 'matched');
});

test('unresolved notional order can reconcile a coherent broker fill without expected quantity', async () => {
  const localOrder = {
    _id: 'local-notional-fill',
    userId: 'user-notional-fill',
    accountId: 'user:notional-fill',
    environment: 'paper',
    externalOrderId: null,
    clientOrderId: 'notional-fill-client',
    qty: null,
    notional: 100,
    status: 'pending_submit',
    submissionState: SUBMISSION_STATES.UNKNOWN,
    save: async function save() { return this; }
  };
  const deps = {
    RoboTradeOrder: {
      find: () => ({
        sort: () => ({
          limit: async () => [localOrder]
        })
      }),
      findOne: async () => ({ _id: localOrder._id }),
      create: async payload => payload
    },
    RoboAuditLog: {
      create: async payload => payload
    },
    createAlpacaBroker: () => ({
      getOrder: async () => {
        throw new Error('external-ID lookup must not run');
      },
      getOrderByClientOrderId: async clientOrderId => ({
        id: 'alpaca-notional-fill',
        client_order_id: clientOrderId,
        status: 'filled',
        filled_qty: '0.5',
        filled_avg_price: '200'
      }),
      listOrders: async () => []
    })
  };

  const result = await reconcileRoboOrders({ mode: 'paper' }, deps);

  assert.equal(result.updatedCount, 1);
  assert.equal(localOrder.externalOrderId, 'alpaca-notional-fill');
  assert.equal(localOrder.status, 'filled');
  assert.equal(localOrder.submissionState, SUBMISSION_STATES.SUBMITTED);
  assert.equal(localOrder.filledQty, 0.5);
  assert.equal(localOrder.filledAvgPrice, 200);
  assert.equal(localOrder.reconciliationStatus, 'matched');
});

test('ordinary reconciliation rejects every missing or mismatched persisted identity', async t => {
  const cases = [
    {
      name: 'missing returned client id',
      remote: {
        id: 'alpaca-persisted',
        status: 'accepted'
      }
    },
    {
      name: 'mismatched returned client id',
      remote: {
        id: 'alpaca-persisted',
        client_order_id: 'different-client',
        status: 'accepted'
      }
    },
    {
      name: 'missing returned external id',
      remote: {
        client_order_id: 'client-persisted',
        status: 'accepted'
      }
    },
    {
      name: 'mismatched returned external id',
      remote: {
        id: 'different-external',
        client_order_id: 'client-persisted',
        status: 'accepted'
      }
    },
    {
      name: 'missing returned status',
      remote: {
        id: 'alpaca-persisted',
        client_order_id: 'client-persisted'
      }
    },
    {
      name: 'unrecognized returned status',
      remote: {
        id: 'alpaca-persisted',
        client_order_id: 'client-persisted',
        status: 'not-a-real-alpaca-status'
      }
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const localOrder = {
        _id: `ordinary-${scenario.name}`,
        userId: 'user-identity',
        environment: 'paper',
        externalOrderId: 'alpaca-persisted',
        clientOrderId: 'client-persisted',
        status: 'accepted',
        submissionState: SUBMISSION_STATES.SUBMITTED,
        save: async function save() { return this; }
      };
      const deps = {
        RoboTradeOrder: {
          find: () => ({
            sort: () => ({
              limit: async () => [localOrder]
            })
          }),
          findOne: () => ({ lean: async () => null }),
          create: async payload => payload
        },
        RoboAuditLog: { create: async payload => payload },
        createAlpacaBroker: () => ({
          getOrder: async orderId => {
            assert.equal(orderId, 'alpaca-persisted');
            return scenario.remote;
          },
          listOrders: async () => []
        })
      };

      const result = await reconcileRoboOrders({ mode: 'paper' }, deps);

      assert.equal(result.updatedCount, 0);
      assert.equal(localOrder.externalOrderId, 'alpaca-persisted');
      assert.equal(localOrder.clientOrderId, 'client-persisted');
      assert.equal(localOrder.status, 'accepted');
      assert.equal(localOrder.reconciliationStatus, 'alpaca_lookup_failed');
      assert.equal(
        result.discrepancies.some(item => item.type === 'alpaca_lookup_failed'),
        true
      );
    });
  }
});

test('unknown reconciliation learns an external id only from an exact persisted client id', async t => {
  const cases = [
    {
      name: 'missing returned client id',
      remote: {
        id: 'alpaca-untrusted',
        status: 'accepted'
      }
    },
    {
      name: 'mismatched returned client id',
      remote: {
        id: 'alpaca-untrusted',
        client_order_id: 'different-client',
        status: 'accepted'
      }
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const localOrder = {
        _id: `unknown-${scenario.name}`,
        userId: 'user-identity',
        environment: 'paper',
        externalOrderId: null,
        clientOrderId: 'client-persisted',
        status: 'pending_submit',
        submissionState: SUBMISSION_STATES.UNKNOWN,
        save: async function save() { return this; }
      };
      const deps = {
        RoboTradeOrder: {
          find: () => ({
            sort: () => ({
              limit: async () => [localOrder]
            })
          }),
          findOne: () => ({ lean: async () => null }),
          create: async payload => payload
        },
        RoboAuditLog: { create: async payload => payload },
        createAlpacaBroker: () => ({
          getOrderByClientOrderId: async clientOrderId => {
            assert.equal(clientOrderId, 'client-persisted');
            return scenario.remote;
          },
          listOrders: async () => []
        })
      };

      const result = await reconcileRoboOrders({ mode: 'paper' }, deps);

      assert.equal(result.updatedCount, 0);
      assert.equal(localOrder.externalOrderId, null);
      assert.equal(localOrder.clientOrderId, 'client-persisted');
      assert.equal(localOrder.status, 'pending_submit');
      assert.equal(localOrder.submissionState, SUBMISSION_STATES.UNKNOWN);
      assert.equal(localOrder.reconciliationStatus, 'submit_unknown');
      assert.equal(
        result.discrepancies.some(item => item.type === 'submission_lookup_inconclusive'),
        true
      );
    });
  }
});

test('reconciliation lookup 404 retains submit unknown under the original identity and never submits again', async () => {
  const originalClientOrderId = 'daytrader-robotrader-AAPL-unknown';
  let brokerSubmissions = 0;
  const saved = [];
  const localOrder = {
    _id: 'local-order-unknown-404',
    userId: 'user-1',
    accountId: 'user:test',
    environment: 'paper',
    externalOrderId: null,
    clientOrderId: originalClientOrderId,
    status: 'pending_submit',
    submissionState: SUBMISSION_STATES.UNKNOWN,
    rejectedAt: null,
    save: async function save() {
      saved.push({
        clientOrderId: this.clientOrderId,
        status: this.status,
        submissionState: this.submissionState,
        reconciliationStatus: this.reconciliationStatus,
        rejectedAt: this.rejectedAt
      });
      return this;
    }
  };
  const deps = {
    RoboTradeOrder: {
      find: query => ({
        sort: () => ({
          limit: async () => {
            if (query.status === 'rejected') return [];
            if (query.status === 'filled') return [];
            if (query.exitReason === 'stop_loss') return [];
            return [localOrder];
          }
        })
      }),
      findOne: () => ({ lean: async () => null }),
      create: async payload => payload
    },
    RoboAuditLog: { create: async payload => payload },
    createAlpacaBroker: () => ({
      getOrderByClientOrderId: async clientOrderId => {
        assert.equal(clientOrderId, originalClientOrderId);
        const err = new Error('not found');
        err.response = { status: 404 };
        throw err;
      },
      getPositions: async () => [],
      submitOrder: async () => {
        brokerSubmissions += 1;
      },
      listOrders: async () => []
    })
  };

  const result = await reconcileRoboOrders({
    mode: 'paper',
    userId: 'user-1',
    accountId: 'user:test'
  }, deps);

  assert.equal(brokerSubmissions, 0);
  assert.equal(localOrder.clientOrderId, originalClientOrderId);
  assert.equal(localOrder.status, 'pending_submit');
  assert.equal(localOrder.submissionState, SUBMISSION_STATES.UNKNOWN);
  assert.equal(localOrder.reconciliationStatus, 'submit_unknown');
  assert.equal(localOrder.rejectedAt, null);
  assert.equal(saved.at(-1).clientOrderId, originalClientOrderId);
  assert.equal(
    result.discrepancies.some(item => item.type === 'submission_lookup_not_found'),
    true
  );
});

test('reconciliation lookup transport failures retain submit unknown and never submit again', async () => {
  const originalClientOrderId = 'daytrader-robotrader-MSFT-unknown';
  let brokerSubmissions = 0;
  const localOrder = {
    _id: 'local-order-unknown-timeout',
    userId: 'user-1',
    accountId: 'user:test',
    environment: 'paper',
    externalOrderId: null,
    clientOrderId: originalClientOrderId,
    status: 'pending_submit',
    submissionState: SUBMISSION_STATES.UNKNOWN,
    rejectedAt: null,
    save: async function save() { return this; }
  };
  const deps = {
    RoboTradeOrder: {
      find: query => ({
        sort: () => ({
          limit: async () => {
            if (query.status === 'rejected' || query.status === 'filled' || query.exitReason === 'stop_loss') {
              return [];
            }
            return [localOrder];
          }
        })
      }),
      findOne: () => ({ lean: async () => null }),
      create: async payload => payload
    },
    RoboAuditLog: { create: async payload => payload },
    createAlpacaBroker: () => ({
      getOrderByClientOrderId: async clientOrderId => {
        assert.equal(clientOrderId, originalClientOrderId);
        const err = new Error('broker lookup timed out');
        err.code = 'ETIMEDOUT';
        throw err;
      },
      getPositions: async () => [],
      submitOrder: async () => {
        brokerSubmissions += 1;
      },
      listOrders: async () => []
    })
  };

  const result = await reconcileRoboOrders({
    mode: 'paper',
    userId: 'user-1',
    accountId: 'user:test'
  }, deps);

  assert.equal(brokerSubmissions, 0);
  assert.equal(localOrder.clientOrderId, originalClientOrderId);
  assert.equal(localOrder.status, 'pending_submit');
  assert.equal(localOrder.submissionState, SUBMISSION_STATES.UNKNOWN);
  assert.equal(localOrder.reconciliationStatus, 'submit_unknown');
  assert.equal(localOrder.rejectedAt, null);
  assert.equal(
    result.discrepancies.some(item => item.type === 'submission_lookup_failed'),
    true
  );
});

test('legacy rejected rows are excluded from broker-confirmed rejection resolution', async () => {
  let lookupCalls = 0;
  let capturedQuery = null;
  const legacyRejected = {
    _id: 'legacy-rejected-ambiguous',
    status: 'rejected',
    submissionState: null,
    externalOrderId: null,
    clientOrderId: 'legacy-possibly-ambiguous',
    discrepancy: 'legacy rejection without affirmative classification',
    save: async function save() { return this; }
  };
  const deps = {
    RoboTradeOrder: {
      find: query => {
        capturedQuery = query;
        return {
          sort: () => ({
            limit: async () => [legacyRejected]
          })
        };
      }
    },
    RoboAuditLog: { create: async payload => payload }
  };

  const result = await reconcileRejectedSubmissions({
    mode: 'paper',
    broker: {
      getOrderByClientOrderId: async () => {
        lookupCalls += 1;
        const err = new Error('not found');
        err.response = { status: 404 };
        throw err;
      }
    }
  }, deps);

  assert.equal(capturedQuery.submissionState, SUBMISSION_STATES.REJECTED);
  assert.equal(lookupCalls, 0);
  assert.deepEqual(result.resolved, []);
  assert.equal(legacyRejected.discrepancy, 'legacy rejection without affirmative classification');
});

test('inconclusive rejected-submission lookup data cannot manufacture broker truth', async () => {
  let saveCalls = 0;
  const rejectedOrder = {
    _id: 'rejected-inconclusive-lookup',
    userId: 'user-1',
    environment: 'paper',
    status: 'rejected',
    submissionState: SUBMISSION_STATES.REJECTED,
    externalOrderId: null,
    clientOrderId: 'confirmed-rejected-client-id',
    discrepancy: 'Broker 422: invalid order',
    save: async function save() {
      saveCalls += 1;
      return this;
    }
  };
  const deps = {
    RoboTradeOrder: {
      find: () => ({
        sort: () => ({
          limit: async () => [rejectedOrder]
        })
      })
    },
    RoboAuditLog: { create: async payload => payload }
  };

  const result = await reconcileRejectedSubmissions({
    mode: 'paper',
    broker: {
      getOrderByClientOrderId: async () => ({})
    }
  }, deps);

  assert.equal(saveCalls, 0);
  assert.equal(rejectedOrder.status, 'rejected');
  assert.equal(rejectedOrder.submissionState, SUBMISSION_STATES.REJECTED);
  assert.equal(rejectedOrder.clientOrderId, 'confirmed-rejected-client-id');
  assert.deepEqual(result.resolved, []);
  assert.equal(result.discrepancies[0].type, 'rejected_submission_lookup_inconclusive');
});

test('rejected reconciliation rejects missing or mismatched returned client identities', async t => {
  const cases = [
    {
      name: 'missing returned client id',
      remote: {
        id: 'alpaca-rejected-lookup',
        status: 'accepted'
      }
    },
    {
      name: 'mismatched returned client id',
      remote: {
        id: 'alpaca-rejected-lookup',
        client_order_id: 'different-client',
        status: 'accepted'
      }
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      let saveCalls = 0;
      const rejectedOrder = {
        _id: `rejected-${scenario.name}`,
        userId: 'user-identity',
        environment: 'paper',
        status: 'rejected',
        submissionState: SUBMISSION_STATES.REJECTED,
        externalOrderId: null,
        clientOrderId: 'client-persisted',
        discrepancy: 'Broker 422: invalid order',
        save: async function save() {
          saveCalls += 1;
          return this;
        }
      };
      const deps = {
        RoboTradeOrder: {
          find: () => ({
            sort: () => ({
              limit: async () => [rejectedOrder]
            })
          })
        },
        RoboAuditLog: { create: async payload => payload }
      };

      const result = await reconcileRejectedSubmissions({
        mode: 'paper',
        broker: {
          getOrderByClientOrderId: async clientOrderId => {
            assert.equal(clientOrderId, 'client-persisted');
            return scenario.remote;
          }
        }
      }, deps);

      assert.equal(saveCalls, 0);
      assert.deepEqual(result.resolved, []);
      assert.equal(result.discrepancies[0].type, 'rejected_submission_lookup_inconclusive');
      assert.equal(rejectedOrder.externalOrderId, null);
      assert.equal(rejectedOrder.clientOrderId, 'client-persisted');
      assert.equal(rejectedOrder.status, 'rejected');
      assert.equal(rejectedOrder.submissionState, SUBMISSION_STATES.REJECTED);
    });
  }
});

test('robotrader reconciliation scopes local orders by user and does not create unattributed orphans for user runs', async () => {
  let localOrderQuery = null;
  let orphanCreateAttempted = false;
  const deps = {
    RoboTradeOrder: {
      find: query => {
        localOrderQuery = query;
        return {
          sort: () => ({
            limit: async () => []
          })
        };
      },
      findOne: () => ({
        lean: async () => null
      }),
      create: async () => {
        orphanCreateAttempted = true;
        throw new Error('user-scoped reconciliation should not create unattributed orphan records');
      }
    },
    RoboAuditLog: {
      create: async payload => payload
    },
    createAlpacaBroker: () => ({
      getOrder: async () => null,
      listOrders: async () => [{
        id: 'alpaca-orphan-1',
        client_order_id: 'daytrader-robotrader-AAPL-20260520120000-test',
        symbol: 'AAPL',
        side: 'buy',
        type: 'market',
        time_in_force: 'day',
        status: 'filled'
      }]
    })
  };
  installPaperSubmissionGuard(deps);

  const result = await reconcileRoboOrders({ mode: 'paper', userId: 'user-1' }, deps);

  assert.equal(localOrderQuery.userId, 'user-1');
  assert.equal(result.discrepancyCount, 1);
  assert.equal(result.discrepancies[0].type, 'unattributed_alpaca_order');
  assert.equal(orphanCreateAttempted, false);
});

test('robotrader reconciliation submits protective stop for filled simple fractional entries', async () => {
  const filledEntry = {
    _id: 'parent-order-1',
    userId: 'user-1',
    accountId: 'default',
    decisionId: 'decision-1',
    environment: 'paper',
    broker: 'alpaca',
    externalOrderId: 'alpaca-parent-1',
    clientOrderId: 'daytrader-robotrader-AAPL-parent',
    symbol: 'AAPL',
    assetClass: 'stocks',
    side: 'buy',
    orderType: 'market',
    orderClass: 'simple',
    timeInForce: 'day',
    qty: 1.25,
    filledQty: 1.25,
    status: 'filled',
    riskStopPrice: 190,
    riskTakeProfitPrice: 215,
    strategyId: 'TEST_STRATEGY',
    riskChecks: []
  };
  const createdOrders = [];
  const auditEvents = [];
  const deps = {
    RoboTradeOrder: {
      find: query => ({
        sort: () => ({
          limit: async () => {
            if (query.status === 'filled') return [filledEntry];
            return [];
          }
        })
      }),
      findOne: () => ({
        lean: async () => null
      }),
      create: async payload => {
        const doc = {
          _id: `protective-${createdOrders.length + 1}`,
          ...payload,
          save: async function save() {
            createdOrders[createdOrders.length - 1] = this;
            return this;
          }
        };
        createdOrders.push(doc);
        return doc;
      }
    },
    RoboAuditLog: {
      create: async payload => {
        auditEvents.push(payload);
        return payload;
      }
    },
    buildClientOrderId: () => 'daytrader-robotrader-stop-AAPL-fixed',
    createAlpacaBroker: () => ({
      getPositions: async () => [{ symbol: 'AAPL', qty: '1.25' }],
      submitOrder: async input => {
        assert.equal(input.symbol, 'AAPL');
        assert.equal(input.side, 'sell');
        assert.equal(input.orderType, 'stop');
        assert.equal(input.orderClass, 'simple');
        assert.equal(input.timeInForce, 'day');
        assert.equal(input.qty, 1.25);
        assert.equal(input.stopPrice, 190);
        return {
          payload: {
            symbol: 'AAPL',
            side: 'sell',
            type: 'stop',
            qty: '1.25',
            stop_price: '190',
            client_order_id: input.clientOrderId
          },
          order: {
            id: 'alpaca-stop-1',
            client_order_id: input.clientOrderId,
            status: 'accepted',
            submitted_at: '2026-05-24T17:00:00.000Z'
          }
        };
      },
      listOrders: async () => []
    })
  };
  installPaperSubmissionGuard(deps);

  const result = await reconcileRoboOrders({ mode: 'paper', userId: 'user-1' }, deps);

  assert.equal(result.protectiveStopsSubmitted, 1);
  assert.equal(createdOrders.length, 1);
  assert.equal(createdOrders[0].parentOrderId, 'parent-order-1');
  assert.equal(createdOrders[0].parentClientOrderId, 'daytrader-robotrader-AAPL-parent');
  assert.equal(createdOrders[0].exitReason, 'stop_loss');
  assert.equal(createdOrders[0].externalOrderId, 'alpaca-stop-1');
  assert.equal(createdOrders[0].status, 'accepted');
  assert.equal(createdOrders[0].reconciliationStatus, 'matched');
  assert.equal(auditEvents.some(event => event.eventType === 'robotrader_protective_stop_submitted'), true);
});

test('robotrader protective stop creation handles duplicate parent exit races', async () => {
  let findOneCalls = 0;
  let submitAttempted = false;
  const existingStop = {
    _id: 'existing-stop-1',
    parentOrderId: 'parent-order-1',
    exitReason: 'stop_loss',
    status: 'accepted'
  };
  const deps = {
    RoboTradeOrder: {
      findOne: () => ({
        lean: async () => {
          findOneCalls += 1;
          return findOneCalls === 1 ? null : existingStop;
        }
      }),
      create: async () => {
        const err = new Error('duplicate key');
        err.code = 11000;
        throw err;
      }
    },
    RoboAuditLog: {
      create: async payload => payload
    },
    buildClientOrderId: () => 'daytrader-robotrader-stop-AAPL-fixed'
  };
  installPaperSubmissionGuard(deps);

  const result = await submitProtectiveStopForEntry({
    _id: 'parent-order-1',
    userId: 'user-1',
    accountId: 'default',
    environment: 'paper',
    clientOrderId: 'daytrader-robotrader-AAPL-parent',
    symbol: 'AAPL',
    assetClass: 'stocks',
    side: 'buy',
    orderClass: 'simple',
    status: 'filled',
    qty: 1.25,
    filledQty: 1.25,
    riskStopPrice: 190
  }, {
    positions: [{ symbol: 'AAPL', qty: '1.25' }],
    broker: {
      submitOrder: async () => {
        submitAttempted = true;
      }
    }
  }, deps);

  assert.equal(result, existingStop);
  assert.equal(submitAttempted, false);
});

test('protective stop lock contention performs no broker submission or identity creation', async () => {
  let generatedClientOrderIds = 0;
  let createdOrders = 0;
  let brokerSubmissions = 0;
  const audits = [];
  const deps = {
    RoboTradeOrder: {
      findOne: async () => null,
      create: async () => {
        createdOrders += 1;
      }
    },
    RoboAuditLog: {
      create: async payload => {
        audits.push(payload);
        return payload;
      }
    },
    buildClientOrderId: () => {
      generatedClientOrderIds += 1;
      return 'must-not-be-generated';
    }
  };
  installPaperSubmissionGuard(deps, { acquire: false });

  const result = await submitProtectiveStopForEntry({
    _id: 'parent-order-lock-contention',
    userId: 'user-1',
    accountId: 'user:test',
    environment: 'paper',
    clientOrderId: 'parent-client-id',
    symbol: 'AAPL',
    assetClass: 'stocks',
    side: 'buy',
    orderClass: 'simple',
    status: 'filled',
    qty: 1,
    filledQty: 1,
    riskStopPrice: 190
  }, {
    positions: [{ symbol: 'AAPL', qty: '1', current_price: '200' }],
    broker: {
      submitOrder: async () => {
        brokerSubmissions += 1;
      }
    }
  }, deps);

  assert.equal(result, null);
  assert.equal(createdOrders, 0);
  assert.equal(generatedClientOrderIds, 0);
  assert.equal(brokerSubmissions, 0);
  assert.equal(audits[0].eventType, 'robotrader_protective_stop_blocked');
  assert.equal(audits[0].payload.submissionState, SUBMISSION_STATES.NOT_ATTEMPTED);
});

test('live protective stop is blocked by a pre-existing same-account unknown on another symbol', async () => {
  let unresolvedQueryCount = 0;
  let createdOrders = 0;
  let generatedClientOrderIds = 0;
  let brokerSubmissions = 0;
  const audits = [];
  const priorUnknown = {
    _id: 'live-unknown-aapl',
    accountId: 'user:live-freeze',
    environment: 'live',
    symbol: 'AAPL',
    status: 'pending_submit',
    submissionState: SUBMISSION_STATES.UNKNOWN,
    clientOrderId: 'live-unknown-client'
  };
  const deps = {
    RoboTradeOrder: {
      findOne: filter => {
        if (filter.$or) {
          unresolvedQueryCount += 1;
          return priorUnknown;
        }
        return null;
      },
      create: async () => {
        createdOrders += 1;
      }
    },
    RoboAuditLog: {
      create: async payload => {
        audits.push(payload);
        return payload;
      }
    },
    buildClientOrderId: () => {
      generatedClientOrderIds += 1;
      return 'must-not-be-generated';
    }
  };

  const result = await submitProtectiveStopForEntry({
    _id: 'live-parent-msft',
    userId: 'user-live-freeze',
    accountId: 'user:live-freeze',
    environment: 'live',
    clientOrderId: 'live-parent-client',
    symbol: 'MSFT',
    assetClass: 'stocks',
    side: 'buy',
    orderClass: 'simple',
    status: 'filled',
    qty: 1,
    filledQty: 1,
    riskStopPrice: 390
  }, {
    positions: [{ symbol: 'MSFT', qty: '1', current_price: '400' }],
    broker: {
      submitOrder: async () => {
        brokerSubmissions += 1;
      }
    }
  }, deps);

  assert.equal(result, null);
  assert.equal(unresolvedQueryCount, 1);
  assert.equal(createdOrders, 0);
  assert.equal(generatedClientOrderIds, 0);
  assert.equal(brokerSubmissions, 0);
  assert.equal(audits.at(-1).payload.code, 'UNRESOLVED_ALPACA_SUBMISSION');
  assert.equal(audits.at(-1).payload.submissionState, SUBMISSION_STATES.NOT_ATTEMPTED);
  assert.equal(audits.at(-1).payload.submissionAttempted, false);
});

test('live protective stop rechecks the unknown latch after durable identity and before POST', async () => {
  let unresolvedQueryCount = 0;
  let brokerSubmissions = 0;
  let storedStop = null;
  const audits = [];
  const lateUnknown = {
    _id: 'live-late-unknown-aapl',
    accountId: 'user:live-late-freeze',
    environment: 'live',
    symbol: 'AAPL',
    status: 'pending_submit',
    submissionState: SUBMISSION_STATES.UNKNOWN,
    clientOrderId: 'live-late-unknown-client'
  };
  const deps = {
    RoboTradeOrder: {
      findOne: filter => {
        if (filter.exitReason === 'stop_loss') return null;
        if (!filter.accountId || !filter.environment || !filter.$or) return null;
        unresolvedQueryCount += 1;
        return unresolvedQueryCount === 1 ? null : lateUnknown;
      },
      create: async payload => {
        storedStop = {
          _id: 'live-protective-pending-msft',
          ...payload,
          save: async function save() { return this; }
        };
        return storedStop;
      }
    },
    RoboAuditLog: {
      create: async payload => {
        audits.push(payload);
        return payload;
      }
    },
    buildClientOrderId: () => 'live-protective-pending-client'
  };

  const result = await submitProtectiveStopForEntry({
    _id: 'live-parent-late-msft',
    userId: 'user-live-late-freeze',
    accountId: 'user:live-late-freeze',
    environment: 'live',
    clientOrderId: 'live-parent-late-client',
    symbol: 'MSFT',
    assetClass: 'stocks',
    side: 'buy',
    orderClass: 'simple',
    status: 'filled',
    qty: 1,
    filledQty: 1,
    riskStopPrice: 390
  }, {
    positions: [{ symbol: 'MSFT', qty: '1', current_price: '400' }],
    broker: {
      submitOrder: async () => {
        brokerSubmissions += 1;
      }
    }
  }, deps);

  assert.equal(result, storedStop);
  assert.equal(unresolvedQueryCount, 2);
  assert.equal(brokerSubmissions, 0);
  assert.equal(storedStop.status, 'canceled');
  assert.equal(storedStop.submissionState, SUBMISSION_STATES.NOT_ATTEMPTED);
  assert.equal(storedStop.submissionAttemptCount, 0);
  assert.equal(storedStop.submissionLastAttemptAt, null);
  assert.equal(storedStop.externalOrderId, null);
  assert.equal(storedStop.rejectedAt, null);
  assert.equal(storedStop.submissionLastError.submissionAttempted, false);
  assert.equal(storedStop.submissionLastError.code, 'UNRESOLVED_ALPACA_SUBMISSION');
  assert.equal(audits.at(-1).payload.submissionState, SUBMISSION_STATES.NOT_ATTEMPTED);
});

test('live protective stop fails closed when either unresolved-latch read throws', async t => {
  for (const failureAt of ['precheck', 'final']) {
    await t.test(failureAt, async () => {
      let unresolvedQueryCount = 0;
      let brokerSubmissions = 0;
      let generatedClientOrderIds = 0;
      let storedStop = null;
      const audits = [];
      const deps = {
        RoboTradeOrder: {
          findOne: filter => {
            if (filter.exitReason === 'stop_loss') return null;
            if (!filter.accountId || !filter.environment || !filter.$or) return null;
            unresolvedQueryCount += 1;
            if (
              failureAt === 'precheck'
              || (failureAt === 'final' && unresolvedQueryCount === 2)
            ) {
              throw new Error('live order database unavailable');
            }
            return null;
          },
          create: async payload => {
            storedStop = {
              _id: `live-protective-${failureAt}`,
              ...payload,
              save: async function save() { return this; }
            };
            return storedStop;
          }
        },
        RoboAuditLog: {
          create: async payload => {
            audits.push(payload);
            return payload;
          }
        },
        buildClientOrderId: () => {
          generatedClientOrderIds += 1;
          return `live-protective-${failureAt}-client`;
        }
      };

      const result = await submitProtectiveStopForEntry({
        _id: `live-parent-${failureAt}`,
        userId: 'user-live-latch-failure',
        accountId: 'user:live-latch-failure',
        environment: 'live',
        clientOrderId: 'live-parent-client',
        symbol: 'MSFT',
        assetClass: 'stocks',
        side: 'buy',
        orderClass: 'simple',
        status: 'filled',
        qty: 1,
        filledQty: 1,
        riskStopPrice: 390
      }, {
        positions: [{ symbol: 'MSFT', qty: '1', current_price: '400' }],
        broker: {
          submitOrder: async () => {
            brokerSubmissions += 1;
          }
        }
      }, deps);

      assert.equal(brokerSubmissions, 0);
      assert.equal(audits.at(-1).payload.submissionState, SUBMISSION_STATES.NOT_ATTEMPTED);
      assert.equal(audits.at(-1).payload.submissionAttempted, false);
      if (failureAt === 'precheck') {
        assert.equal(result, null);
        assert.equal(generatedClientOrderIds, 0);
        assert.equal(storedStop, null);
      } else {
        assert.equal(result, storedStop);
        assert.equal(generatedClientOrderIds, 1);
        assert.equal(storedStop.status, 'canceled');
        assert.equal(storedStop.submissionState, SUBMISSION_STATES.NOT_ATTEMPTED);
        assert.equal(storedStop.submissionAttemptCount, 0);
        assert.equal(storedStop.submissionLastAttemptAt, null);
        assert.equal(storedStop.submissionLastError.submissionAttempted, false);
        assert.equal(storedStop.submissionLastError.code, 'ALPACA_SUBMISSION_COORDINATION_FAILED');
      }
    });
  }
});

test('protective stop lease loss after persistence resets the attempt and never POSTs', async () => {
  let storedStop = null;
  let brokerSubmissions = 0;
  const audits = [];
  const deps = {
    RoboTradeOrder: {
      findOne: async () => null,
      create: async payload => {
        storedStop = {
          _id: 'protective-lease-lost',
          ...payload,
          save: async function save() {
            return this;
          }
        };
        return storedStop;
      }
    },
    RoboAuditLog: {
      create: async payload => {
        audits.push(payload);
        return payload;
      }
    },
    buildClientOrderId: () => 'protective-lease-lost-client'
  };
  installPaperSubmissionGuard(deps, { renew: false });

  const result = await submitProtectiveStopForEntry({
    _id: 'parent-order-lease-lost',
    userId: 'user-1',
    accountId: 'user:test',
    environment: 'paper',
    clientOrderId: 'parent-client-id',
    symbol: 'AAPL',
    assetClass: 'stocks',
    side: 'buy',
    orderClass: 'simple',
    status: 'filled',
    qty: 1,
    filledQty: 1,
    riskStopPrice: 190
  }, {
    positions: [{ symbol: 'AAPL', qty: '1', current_price: '200' }],
    broker: {
      submitOrder: async () => {
        brokerSubmissions += 1;
      }
    }
  }, deps);

  assert.equal(result, storedStop);
  assert.equal(brokerSubmissions, 0);
  assert.equal(storedStop.status, 'canceled');
  assert.equal(storedStop.submissionState, SUBMISSION_STATES.NOT_ATTEMPTED);
  assert.equal(storedStop.submissionAttemptCount, 0);
  assert.equal(storedStop.submissionLastAttemptAt, null);
  assert.equal(storedStop.rejectedAt, null);
  assert.equal(
    audits.some(event => event.eventType === 'robotrader_protective_stop_blocked'),
    true
  );
});

test('protective stop classifies thrown final coordination operations as not attempted', async t => {
  for (const failureAt of ['renew', 'late_query']) {
    await t.test(failureAt, async () => {
      let storedStop = null;
      let brokerSubmissions = 0;
      let unresolvedReads = 0;
      const audits = [];
      const deps = {
        RoboTradeOrder: {
          findOne: async () => null,
          create: async payload => {
            storedStop = {
              _id: `protective-coordination-${failureAt}`,
              ...payload,
              save: async function save() {
                return this;
              }
            };
            return storedStop;
          }
        },
        RoboAuditLog: {
          create: async payload => {
            audits.push(payload);
            return payload;
          }
        },
        buildClientOrderId: () => `protective-coordination-${failureAt}-client`
      };
      installPaperSubmissionGuard(deps);
      if (failureAt === 'renew') {
        deps.renewAlpacaPaperSubmissionLock = async () => {
          throw new Error('lock database unavailable');
        };
      } else {
        deps.findUnresolvedAlpacaPaperSubmission = async () => {
          unresolvedReads += 1;
          if (unresolvedReads === 2) throw new Error('order database unavailable');
          return null;
        };
      }

      const result = await submitProtectiveStopForEntry({
        _id: `parent-order-coordination-${failureAt}`,
        userId: 'user-1',
        accountId: 'user:test',
        environment: 'paper',
        clientOrderId: 'parent-client-id',
        symbol: 'AAPL',
        assetClass: 'stocks',
        side: 'buy',
        orderClass: 'simple',
        status: 'filled',
        qty: 1,
        filledQty: 1,
        riskStopPrice: 190
      }, {
        positions: [{ symbol: 'AAPL', qty: '1', current_price: '200' }],
        broker: {
          submitOrder: async () => {
            brokerSubmissions += 1;
          }
        }
      }, deps);

      assert.equal(result, storedStop);
      assert.equal(brokerSubmissions, 0);
      assert.equal(storedStop.status, 'canceled');
      assert.equal(storedStop.submissionState, SUBMISSION_STATES.NOT_ATTEMPTED);
      assert.equal(storedStop.submissionAttemptCount, 0);
      assert.equal(storedStop.submissionLastAttemptAt, null);
      assert.equal(storedStop.submittedAt, null);
      assert.equal(storedStop.filledAt, null);
      assert.equal(storedStop.rejectedAt, null);
      assert.equal(storedStop.submissionLastError.submissionAttempted, false);
      assert.equal(
        storedStop.submissionLastError.code,
        'ALPACA_PAPER_SUBMISSION_COORDINATION_FAILED'
      );
      assert.equal(
        audits.some(event => event.eventType === 'robotrader_protective_stop_blocked'),
        true
      );
      if (failureAt === 'late_query') assert.equal(unresolvedReads, 2);
    });
  }
});

test('protective stop resets attempt evidence when the real adapter proves no request began', async () => {
  let storedStop = null;
  let httpCalls = 0;
  const audits = [];
  const preflightBroker = createRealAlpacaBroker({
    mode: 'paper',
    env: {
      APCA_PAPER_BASE_URL: 'https://paper-api.alpaca.markets'
    },
    httpClient: async () => {
      httpCalls += 1;
      return { data: {} };
    }
  });
  const deps = {
    RoboTradeOrder: {
      findOne: async () => null,
      create: async payload => {
        storedStop = {
          _id: 'protective-adapter-not-attempted',
          ...payload,
          save: async function save() {
            return this;
          }
        };
        return storedStop;
      }
    },
    RoboAuditLog: {
      create: async payload => {
        audits.push(payload);
        return payload;
      }
    },
    buildClientOrderId: () => 'protective-adapter-not-attempted-client'
  };
  installPaperSubmissionGuard(deps);

  const result = await submitProtectiveStopForEntry({
    _id: 'parent-order-adapter-not-attempted',
    userId: 'user-1',
    accountId: 'user:test',
    environment: 'paper',
    clientOrderId: 'parent-client-id',
    symbol: 'AAPL',
    assetClass: 'stocks',
    side: 'buy',
    orderClass: 'simple',
    status: 'filled',
    qty: 1,
    filledQty: 1,
    riskStopPrice: 190
  }, {
    positions: [{ symbol: 'AAPL', qty: '1', current_price: '200' }],
    broker: preflightBroker
  }, deps);

  assert.equal(result, storedStop);
  assert.equal(httpCalls, 0);
  assert.equal(storedStop.status, 'canceled');
  assert.equal(storedStop.submissionState, SUBMISSION_STATES.NOT_ATTEMPTED);
  assert.equal(storedStop.submissionAttemptCount, 0);
  assert.equal(storedStop.submissionLastAttemptAt, null);
  assert.equal(storedStop.submittedAt, null);
  assert.equal(storedStop.filledAt, null);
  assert.equal(storedStop.rejectedAt, null);
  assert.ok(storedStop.canceledAt);
  assert.equal(
    audits.some(event => (
      event.eventType === 'robotrader_protective_stop_error'
      && event.payload.submissionState === SUBMISSION_STATES.NOT_ATTEMPTED
    )),
    true
  );
});

test('protective stop keeps Alpaca duplicate client identity errors unknown and non-replayable', async () => {
  let storedStop = null;
  let brokerSubmissions = 0;
  const audits = [];
  const deps = {
    RoboTradeOrder: {
      findOne: async () => null,
      create: async payload => {
        storedStop = {
          _id: 'protective-duplicate-client-unknown',
          ...payload,
          save: async function save() {
            return this;
          }
        };
        return storedStop;
      }
    },
    RoboAuditLog: {
      create: async payload => {
        audits.push(payload);
        return payload;
      }
    },
    buildClientOrderId: () => 'protective-duplicate-client-id'
  };
  installPaperSubmissionGuard(deps);

  const result = await submitProtectiveStopForEntry({
    _id: 'parent-order-duplicate-client',
    userId: 'user-1',
    accountId: 'user:test',
    environment: 'paper',
    clientOrderId: 'parent-client-id',
    symbol: 'AAPL',
    assetClass: 'stocks',
    side: 'buy',
    orderClass: 'simple',
    status: 'filled',
    qty: 1,
    filledQty: 1,
    riskStopPrice: 190
  }, {
    positions: [{ symbol: 'AAPL', qty: '1', current_price: '200' }],
    broker: {
      submitOrder: async input => {
        brokerSubmissions += 1;
        const err = new Error('Request failed with status code 422');
        err.response = {
          status: 422,
          data: {
            code: 40010001,
            message: 'client_order_id must be unique'
          }
        };
        err.submissionAttempted = true;
        err.clientOrderId = input.clientOrderId;
        throw err;
      }
    }
  }, deps);

  assert.equal(result, storedStop);
  assert.equal(brokerSubmissions, 1);
  assert.equal(storedStop.clientOrderId, 'protective-duplicate-client-id');
  assert.equal(storedStop.status, 'pending_submit');
  assert.equal(storedStop.submissionState, SUBMISSION_STATES.UNKNOWN);
  assert.equal(storedStop.reconciliationStatus, 'submit_unknown');
  assert.equal(storedStop.submissionAttemptCount, 1);
  assert.equal(storedStop.rejectedAt, null);
  assert.equal(
    audits.some(event => (
      event.eventType === 'robotrader_protective_stop_error'
      && event.payload.submissionState === SUBMISSION_STATES.UNKNOWN
    )),
    true
  );

  const replay = await submitProtectiveStopForEntry({
    _id: 'parent-order-duplicate-client',
    userId: 'user-1',
    accountId: 'user:test',
    environment: 'paper',
    clientOrderId: 'parent-client-id',
    symbol: 'AAPL',
    assetClass: 'stocks',
    side: 'buy',
    orderClass: 'simple',
    status: 'filled',
    qty: 1,
    filledQty: 1,
    riskStopPrice: 190
  }, {
    positions: [{ symbol: 'AAPL', qty: '1', current_price: '200' }],
    broker: {
      submitOrder: async () => {
        brokerSubmissions += 1;
      }
    }
  }, {
    ...deps,
    RoboTradeOrder: {
      ...deps.RoboTradeOrder,
      findOne: async () => storedStop
    }
  });

  assert.equal(replay, null);
  assert.equal(brokerSubmissions, 1);
  assert.equal(storedStop.clientOrderId, 'protective-duplicate-client-id');
});

test('reconciliation never replays or assigns a new identity to an existing protective stop', async () => {
  let createAttempted = false;
  let submittedInput = null;
  let generatedClientOrderIds = 0;
  const existingStop = {
    _id: 'existing-stop-rejected',
    parentOrderId: 'parent-order-1',
    environment: 'paper',
    symbol: 'AAPL',
    status: 'rejected',
    clientOrderId: 'old-rejected-client-id',
    discrepancy: 'old broker rejection',
    rawPayload: {},
    save: async function save() { return this; }
  };
  const deps = {
    RoboTradeOrder: {
      findOne: () => existingStop,
      create: async () => {
        createAttempted = true;
        throw new Error('retry must reuse the unique parent exit record');
      }
    },
    RoboAuditLog: { create: async payload => payload },
    buildClientOrderId: () => {
      generatedClientOrderIds += 1;
      return 'new-protective-client-id';
    }
  };
  installPaperSubmissionGuard(deps);

  const result = await submitProtectiveStopForEntry({
    _id: 'parent-order-1',
    userId: 'user-1',
    accountId: 'user:test',
    environment: 'paper',
    clientOrderId: 'parent-client-id',
    symbol: 'AAPL',
    assetClass: 'stocks',
    side: 'buy',
    orderClass: 'simple',
    status: 'filled',
    qty: 1,
    filledQty: 1,
    riskStopPrice: 190
  }, {
    positions: [{ symbol: 'AAPL', qty: '1', current_price: '200' }],
    broker: {
      submitOrder: async input => {
        submittedInput = input;
        return {
          payload: { client_order_id: input.clientOrderId },
          order: { id: 'replacement-stop-1', client_order_id: input.clientOrderId, status: 'accepted' }
        };
      }
    }
  }, deps);

  assert.equal(createAttempted, false);
  assert.equal(submittedInput, null);
  assert.equal(generatedClientOrderIds, 0);
  assert.equal(result, null);
  assert.equal(existingStop.clientOrderId, 'old-rejected-client-id');
  assert.equal(existingStop.status, 'rejected');
  assert.equal(existingStop.discrepancy, 'old broker rejection');
});

test('protective submission treats missing or mismatched returned client identities as unknown', async t => {
  const cases = [
    {
      name: 'missing returned client id',
      returnedClientOrderId: null,
      returnedStatus: 'accepted'
    },
    {
      name: 'mismatched returned client id',
      returnedClientOrderId: 'different-client',
      returnedStatus: 'accepted'
    },
    {
      name: 'unrecognized returned status',
      returnedClientOrderId: 'protective-client-persisted',
      returnedStatus: 'not-a-real-alpaca-status'
    },
    {
      name: 'malformed returned broker id',
      returnedExternalOrderId: { proxy: 'bad' },
      returnedClientOrderId: 'protective-client-persisted',
      returnedStatus: 'accepted'
    },
    {
      name: 'incomplete filled acknowledgement',
      returnedClientOrderId: 'protective-client-persisted',
      returnedStatus: 'filled'
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      let storedStop = null;
      let brokerSubmissions = 0;
      const deps = {
        RoboTradeOrder: {
          findOne: () => storedStop,
          create: async payload => {
            storedStop = {
              _id: `protective-${scenario.name}`,
              ...payload,
              save: async function save() { return this; }
            };
            return storedStop;
          }
        },
        RoboAuditLog: { create: async payload => payload },
        buildClientOrderId: () => 'protective-client-persisted'
      };
      installPaperSubmissionGuard(deps);
      const parentOrder = {
        _id: `parent-${scenario.name}`,
        userId: 'user-identity',
        accountId: 'user:identity',
        environment: 'paper',
        clientOrderId: 'parent-client',
        symbol: 'AAPL',
        assetClass: 'stocks',
        side: 'buy',
        orderClass: 'simple',
        status: 'filled',
        qty: 1,
        filledQty: 1,
        riskStopPrice: 190
      };
      const broker = {
        submitOrder: async input => {
          brokerSubmissions += 1;
          return {
            payload: { client_order_id: input.clientOrderId },
            order: {
              id: scenario.returnedExternalOrderId ?? 'alpaca-protective-untrusted',
              ...(scenario.returnedClientOrderId
                ? { client_order_id: scenario.returnedClientOrderId }
                : {}),
              status: scenario.returnedStatus
            }
          };
        }
      };

      const result = await submitProtectiveStopForEntry(parentOrder, {
        positions: [{ symbol: 'AAPL', qty: '1', current_price: '200' }],
        broker
      }, deps);

      assert.equal(brokerSubmissions, 1);
      assert.equal(result, storedStop);
      assert.equal(storedStop.clientOrderId, 'protective-client-persisted');
      assert.equal(storedStop.externalOrderId, null);
      assert.equal(storedStop.status, 'pending_submit');
      assert.equal(storedStop.submissionState, SUBMISSION_STATES.UNKNOWN);
      assert.equal(storedStop.reconciliationStatus, 'submit_unknown');
      assert.equal(storedStop.rejectedAt, null);
    });
  }
});

test('an ambiguous protective submit retains one identity, remains unknown, and is never replayed', async () => {
  let storedStop = null;
  let generatedClientOrderIds = 0;
  let brokerSubmissions = 0;
  const audits = [];
  const alerts = [];
  const liveOutcomes = [];
  const deps = {
    RoboTradeOrder: {
      findOne: () => storedStop,
      create: async payload => {
        storedStop = {
          _id: 'protective-unknown-1',
          ...payload,
          save: async function save() { return this; }
        };
        return storedStop;
      }
    },
    RoboAuditLog: {
      create: async payload => {
        audits.push(payload);
        return payload;
      }
    },
    createOperationalAlertFromAudit: async payload => {
      alerts.push(payload);
      return payload;
    },
    recordControlledLiveOutcome: async payload => {
      liveOutcomes.push(payload);
      return payload;
    },
    buildClientOrderId: () => {
      generatedClientOrderIds += 1;
      return 'original-protective-client-id';
    }
  };
  installPaperSubmissionGuard(deps);
  const parentOrder = {
    _id: 'parent-order-unknown-1',
    userId: 'user-1',
    accountId: 'user:test',
    environment: 'live',
    liveActivationId: 'activation-1',
    clientOrderId: 'parent-client-id',
    symbol: 'AAPL',
    assetClass: 'stocks',
    side: 'buy',
    orderClass: 'simple',
    status: 'filled',
    qty: 1,
    filledQty: 1,
    riskStopPrice: 190
  };
  const broker = {
    submitOrder: async input => {
      brokerSubmissions += 1;
      const err = new Error('timeout after broker accepted the order');
      err.code = 'ETIMEDOUT';
      err.alpacaPayload = {
        symbol: input.symbol,
        side: input.side,
        type: input.orderType,
        qty: String(input.qty),
        stop_price: String(input.stopPrice),
        client_order_id: input.clientOrderId
      };
      throw err;
    }
  };

  const firstResult = await submitProtectiveStopForEntry(parentOrder, {
    positions: [{ symbol: 'AAPL', qty: '1', current_price: '200' }],
    broker,
    now: new Date('2026-07-13T14:00:00.000Z')
  }, deps);
  const secondResult = await submitProtectiveStopForEntry(parentOrder, {
    positions: [{ symbol: 'AAPL', qty: '1', current_price: '200' }],
    broker,
    now: new Date('2026-07-13T14:01:00.000Z')
  }, deps);

  assert.equal(firstResult, storedStop);
  assert.equal(secondResult, null);
  assert.equal(brokerSubmissions, 1);
  assert.equal(generatedClientOrderIds, 1);
  assert.equal(storedStop.clientOrderId, 'original-protective-client-id');
  assert.equal(storedStop.status, 'pending_submit');
  assert.equal(storedStop.submissionState, SUBMISSION_STATES.UNKNOWN);
  assert.equal(storedStop.reconciliationStatus, 'submit_unknown');
  assert.equal(storedStop.rejectedAt, null);
  assert.equal(storedStop.submissionAttemptCount, 1);
  assert.deepEqual(storedStop.rawPayload, {
    symbol: 'AAPL',
    side: 'sell',
    type: 'stop',
    qty: '1',
    stop_price: '190',
    client_order_id: 'original-protective-client-id'
  });
  assert.equal(
    audits.some(event => (
      event.eventType === 'robotrader_protective_stop_error'
      && event.payload.submissionState === SUBMISSION_STATES.UNKNOWN
    )),
    true
  );
  assert.equal(
    liveOutcomes.some(outcome => outcome.status === 'submission_uncertain'),
    true
  );
  assert.equal(
    alerts.some(alert => alert.eventType === 'robotrader_protective_stop_error'),
    true
  );
});

test('a conclusive rejected protective acknowledgement is terminal and cannot be automatically replayed', async () => {
  let storedStop = null;
  let brokerSubmissions = 0;
  let generatedClientOrderIds = 0;
  const deps = {
    RoboTradeOrder: {
      findOne: () => storedStop,
      create: async payload => {
        storedStop = {
          _id: 'protective-rejected-1',
          ...payload,
          save: async function save() { return this; }
        };
        return storedStop;
      }
    },
    RoboAuditLog: { create: async payload => payload },
    buildClientOrderId: () => {
      generatedClientOrderIds += 1;
      return 'protective-confirmed-reject-id';
    }
  };
  installPaperSubmissionGuard(deps);
  const parentOrder = {
    _id: 'parent-order-rejected-1',
    userId: 'user-1',
    accountId: 'user:test',
    environment: 'paper',
    clientOrderId: 'parent-client-id',
    symbol: 'AAPL',
    assetClass: 'stocks',
    side: 'buy',
    orderClass: 'simple',
    status: 'filled',
    qty: 1,
    filledQty: 1,
    riskStopPrice: 190
  };
  const broker = {
    submitOrder: async input => {
      brokerSubmissions += 1;
      return {
        payload: {
          client_order_id: input.clientOrderId,
          stop_price: String(input.stopPrice)
        },
        order: {
          id: 'alpaca-protective-rejected',
          client_order_id: input.clientOrderId,
          status: 'rejected',
          rejected_at: '2026-07-13T14:00:01.000Z'
        }
      };
    }
  };

  await submitProtectiveStopForEntry(parentOrder, {
    positions: [{ symbol: 'AAPL', qty: '1', current_price: '200' }],
    broker
  }, deps);
  const replay = await submitProtectiveStopForEntry(parentOrder, {
    positions: [{ symbol: 'AAPL', qty: '1', current_price: '200' }],
    broker
  }, deps);

  assert.equal(replay, null);
  assert.equal(brokerSubmissions, 1);
  assert.equal(generatedClientOrderIds, 1);
  assert.equal(storedStop.clientOrderId, 'protective-confirmed-reject-id');
  assert.equal(storedStop.externalOrderId, 'alpaca-protective-rejected');
  assert.equal(storedStop.status, 'rejected');
  assert.equal(storedStop.submissionState, SUBMISSION_STATES.REJECTED);
  assert.equal(storedStop.reconciliationStatus, 'submit_rejected');
  assert.ok(storedStop.rejectedAt);
});

test('protective submit downstream save faults are not converted to broker rejections', async () => {
  let storedStop = null;
  let brokerSubmissions = 0;
  const deps = {
    RoboTradeOrder: {
      findOne: () => null,
      create: async payload => {
        storedStop = {
          _id: 'protective-save-fault-1',
          ...payload,
          save: async () => {
            throw new Error('protective post-ack save failed');
          }
        };
        return storedStop;
      }
    },
    RoboAuditLog: { create: async payload => payload },
    buildClientOrderId: () => 'protective-save-fault-client'
  };
  installPaperSubmissionGuard(deps);

  await assert.rejects(
    () => submitProtectiveStopForEntry({
      _id: 'parent-order-save-fault-1',
      userId: 'user-1',
      accountId: 'user:test',
      environment: 'paper',
      clientOrderId: 'parent-client-id',
      symbol: 'AAPL',
      assetClass: 'stocks',
      side: 'buy',
      orderClass: 'simple',
      status: 'filled',
      qty: 1,
      filledQty: 1,
      riskStopPrice: 190
    }, {
      positions: [{ symbol: 'AAPL', qty: '1', current_price: '200' }],
      broker: {
        submitOrder: async input => {
          brokerSubmissions += 1;
          return {
            payload: { client_order_id: input.clientOrderId },
            order: {
              id: 'alpaca-protective-save-fault',
              client_order_id: input.clientOrderId,
              status: 'accepted'
            }
          };
        }
      }
    }, deps),
    /protective post-ack save failed/
  );

  assert.equal(brokerSubmissions, 1);
  assert.equal(storedStop.status, 'accepted');
  assert.equal(storedStop.submissionState, SUBMISSION_STATES.SUBMITTED);
  assert.equal(storedStop.rejectedAt, null);
});

test('unknown protective stops reserve position quantity conservatively', async () => {
  let brokerSubmissions = 0;
  let createdOrders = 0;
  let generatedClientOrderIds = 0;
  const candidate = {
    _id: 'parent-order-2',
    userId: 'user-1',
    accountId: 'user:test',
    environment: 'paper',
    clientOrderId: 'parent-client-2',
    symbol: 'AAPL',
    assetClass: 'stocks',
    side: 'buy',
    orderClass: 'simple',
    status: 'filled',
    qty: 1,
    filledQty: 1,
    riskStopPrice: 190
  };
  const unknownStop = {
    _id: 'unknown-stop-for-parent-1',
    parentOrderId: 'parent-order-1',
    environment: 'paper',
    exitReason: 'stop_loss',
    symbol: 'AAPL',
    assetClass: 'stocks',
    side: 'sell',
    qty: 1,
    status: 'pending_submit',
    submissionState: SUBMISSION_STATES.UNKNOWN
  };
  const deps = {
    RoboTradeOrder: {
      find: query => ({
        sort: () => ({
          limit: async () => (query.status === 'filled' ? [candidate] : [unknownStop])
        })
      }),
      findOne: () => null,
      create: async () => {
        createdOrders += 1;
        return {};
      }
    },
    RoboAuditLog: { create: async payload => payload },
    buildClientOrderId: () => {
      generatedClientOrderIds += 1;
      return 'must-not-be-generated';
    }
  };
  installPaperSubmissionGuard(deps);

  const submitted = await submitMissingProtectiveStops({
    mode: 'paper',
    userId: 'user-1',
    accountId: 'user:test',
    limit: 100,
    broker: {
      getPositions: async () => [{ symbol: 'AAPL', qty: '1', current_price: '200' }],
      submitOrder: async () => {
        brokerSubmissions += 1;
      }
    }
  }, deps);

  assert.deepEqual(submitted, []);
  assert.equal(brokerSubmissions, 0);
  assert.equal(createdOrders, 0);
  assert.equal(generatedClientOrderIds, 0);
});

test('reconciliation does not submit a long protective stop at or above the current market price', async () => {
  let submitted = false;
  let created = false;
  const audits = [];
  const alerts = [];
  const deps = {
    RoboTradeOrder: {
      findOne: () => ({ lean: async () => null }),
      create: async () => {
        created = true;
        return {};
      }
    },
    RoboAuditLog: {
      create: async payload => {
        audits.push(payload);
        return payload;
      }
    },
    createOperationalAlertFromAudit: async payload => alerts.push(payload),
    buildClientOrderId: () => 'must-not-be-used'
  };
  installPaperSubmissionGuard(deps);

  const result = await submitProtectiveStopForEntry({
    _id: 'parent-order-1',
    userId: 'user-1',
    environment: 'paper',
    symbol: 'AAPL',
    assetClass: 'stocks',
    side: 'buy',
    orderClass: 'simple',
    status: 'filled',
    qty: 1,
    filledQty: 1,
    riskStopPrice: 190
  }, {
    positions: [{ symbol: 'AAPL', qty: '1', current_price: '185' }],
    broker: { submitOrder: async () => { submitted = true; } }
  }, deps);

  assert.equal(result, null);
  assert.equal(created, false);
  assert.equal(submitted, false);
  assert.equal(audits[0].eventType, 'robotrader_protective_stop_error');
  assert.equal(alerts[0].eventType, 'robotrader_protective_stop_error');
});
