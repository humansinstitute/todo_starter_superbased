/**
 * Mock SuperBased Server for testing
 *
 * Simulates the behavior of the real SuperBased sync server:
 * - Stores records in memory
 * - Tracks updated_at timestamps
 * - Supports fetch and sync operations
 */

export class MockSuperBasedServer {
  constructor() {
    this.records = new Map(); // record_id -> record
    this.requestLog = [];     // Log of all requests for assertions
  }

  /**
   * Reset server state
   */
  reset() {
    this.records.clear();
    this.requestLog = [];
  }

  /**
   * Get a record by ID (for test assertions)
   */
  getRecord(recordId) {
    return this.records.get(recordId);
  }

  /**
   * Set a record directly (for test setup)
   */
  setRecord(record) {
    this.records.set(record.record_id, {
      ...record,
      updated_at: record.updated_at || new Date().toISOString(),
    });
  }

  /**
   * Simulate fetch records endpoint
   * GET /records/:appNpub/fetch
   */
  fetchRecords(options = {}) {
    this.requestLog.push({ type: 'fetch', options, timestamp: new Date().toISOString() });

    const records = Array.from(this.records.values());

    // Filter by collection if specified
    const filtered = options.collection
      ? records.filter(r => r.collection === options.collection)
      : records;

    // Filter by since if specified
    const sinceFiltered = options.since
      ? filtered.filter(r => new Date(r.updated_at) > new Date(options.since))
      : filtered;

    return { records: sinceFiltered };
  }

  /**
   * Simulate sync records endpoint
   * POST /records/:appNpub/sync
   */
  syncRecords(records) {
    this.requestLog.push({ type: 'sync', records, timestamp: new Date().toISOString() });

    const results = [];
    const serverTimestamp = new Date().toISOString();

    for (const record of records) {
      const existing = this.records.get(record.record_id);

      // Server uses the incoming metadata.updated_at but stamps with server time
      const serverRecord = {
        ...record,
        updated_at: serverTimestamp,
        server_received_at: serverTimestamp,
      };

      this.records.set(record.record_id, serverRecord);
      results.push({ record_id: record.record_id, status: 'ok' });
    }

    return { results };
  }

  /**
   * Simulate whoami endpoint
   * GET /auth/me
   */
  whoami() {
    this.requestLog.push({ type: 'whoami', timestamp: new Date().toISOString() });
    return { npub: 'npub1test', pubkey: 'testpubkey' };
  }
}

/**
 * Create a mock SuperBased client that uses the mock server
 */
export function createMockClient(mockServer) {
  return {
    config: {
      appNpub: 'npub1testapp',
      httpUrl: 'http://mock-superbased.test',
      isValid: true,
    },

    async whoami() {
      return mockServer.whoami();
    },

    async fetchRecords(options = {}) {
      // Simulate network delay
      await new Promise(resolve => setTimeout(resolve, 10));
      return mockServer.fetchRecords(options);
    },

    async syncRecords(records) {
      // Simulate network delay
      await new Promise(resolve => setTimeout(resolve, 10));
      return mockServer.syncRecords(records);
    },
  };
}

/**
 * Create test encryption helpers that don't require real Nostr keys
 * Uses simple base64 encoding for test purposes
 */
export function createTestEncryption() {
  const encrypt = (plaintext) => {
    return 'encrypted:' + btoa(plaintext);
  };

  const decrypt = (ciphertext) => {
    if (!ciphertext.startsWith('encrypted:')) {
      throw new Error('Invalid ciphertext');
    }
    return atob(ciphertext.slice(10));
  };

  return { encrypt, decrypt };
}
