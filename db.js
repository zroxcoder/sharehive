// Shared DB shim for ShareHive — cleaned and robust
(function(){
  const TARGET_NAME = 'hivedb';
  const TARGET_VERSION = 1;
  const STORES = [
    'notes','bookmarks','videos','todos','expenses','planner','wiki',
    'uploads','projects','watchlist','courses','profile','community'
  ];

  function ensureDB() {
    return new Promise((resolve, reject) => {
      try {
        // Open without forcing a version so we don't trigger "stored database is a higher version" errors
        const req = indexedDB.open(TARGET_NAME);
        req.onsuccess = (e) => {
          const db = e.target.result;
          db.onversionchange = () => { try { db.close(); } catch (err) {} };
          // If DB is missing stores, create them by performing an upgrade
          if (STORES.some(s => !db.objectStoreNames.contains(s)) || !db.objectStoreNames.contains('expense_categories') || !db.objectStoreNames.contains('todo_categories')) {
            createMissingStores(db, STORES.concat(['expense_categories','todo_categories'])).then(ndb => { window.hiveDB = ndb; resolve(ndb); }).catch(err => reject(err));
            return;
          }
          window.hiveDB = db;
          resolve(db);
        };
        req.onerror = (e) => reject(e.target.error || e);
      } catch (err) {
        reject(err);
      }
    });
  }

  // Map legacy opens to unified DB and ensure minimum version
  const nativeOpen = indexedDB.open.bind(indexedDB);
  indexedDB.open = function(name, version) {
    if (typeof name === 'string') {
      const lower = name.toLowerCase();
      if (lower.includes('sharehive') || lower.includes('share_hive') || lower.includes('share-hive') || lower === 'sharehivedb') {
        name = TARGET_NAME;
      }
      if (name === 'ShareHiveDB') name = TARGET_NAME;
    }
    // If caller didn't specify a version, call nativeOpen without a version
    if (version === undefined || version === null) return nativeOpen(name);
    // If caller specified a lower version than TARGET_VERSION, bump it
    if (version < TARGET_VERSION) version = TARGET_VERSION;
    return nativeOpen(name, version);
  };

  // dbHelpers with validation for store existence
  const dbHelpers = {
    db: null,
    STORES,
    ensure: ensureDB,
    async _getDB() { if (this.db) return this.db; this.db = await ensureDB(); return this.db; },
    _normalizeStoreName(name) {
      if (!name) throw new Error('storeName is required');
      // backward compatibility: accept singular 'todo' as alias for 'todos'
      if (String(name).toLowerCase() === 'todo') return 'todos';
      return String(name);
    },
    async _validateStore(storeName) {
      const name = this._normalizeStoreName(storeName);
      let db = await this._getDB();
      if (!db.objectStoreNames.contains(name)) {
        // try to create missing stores by bumping version
        db = await createMissingStores(db, [name]);
      }
      if (!db.objectStoreNames.contains(name)) throw new Error(`Store \"${name}\" does not exist`);
      return db;
    },
    async addItem(storeName, item) {
      const name = this._normalizeStoreName(storeName);
      if (!item || typeof item !== 'object') throw new Error('item is required for write operation');
      const db = await this._validateStore(name);
      return new Promise((resolve, reject) => {
        try {
          const tx = db.transaction(name, 'readwrite');
          const store = tx.objectStore(name);
          const payload = Object.assign({}, item || {});
          if (Object.prototype.hasOwnProperty.call(payload, 'id')) delete payload.id;
          const req = store.add(payload);
          req.onsuccess = e => resolve(e.target.result);
          req.onerror = e => reject(e.target.error || e);
        } catch (err) { reject(err); }
      });
    },
    async getAll(storeName) {
      const name = this._normalizeStoreName(storeName);
      const db = await this._validateStore(name);
      return new Promise((resolve, reject) => {
        try {
          const tx = db.transaction(name, 'readonly');
          const store = tx.objectStore(name);
          const req = store.getAll();
          req.onsuccess = e => resolve(e.target.result || []);
          req.onerror = e => reject(e.target.error || e);
        } catch (err) { reject(err); }
      });
    },
    async getItem(storeName, id) {
      const name = this._normalizeStoreName(storeName);
      const db = await this._validateStore(name);
      return new Promise((resolve, reject) => {
        try {
          const tx = db.transaction(name, 'readonly');
          const store = tx.objectStore(name);
          const req = store.get(Number(id));
          req.onsuccess = e => resolve(e.target.result);
          req.onerror = e => reject(e.target.error || e);
        } catch (err) { reject(err); }
      });
    },
    async updateItem(storeName, item) {
      const name = this._normalizeStoreName(storeName);
      if (!item || (!Object.prototype.hasOwnProperty.call(item, 'id'))) throw new Error('item.id is required for update');
      const db = await this._validateStore(name);
      return new Promise((resolve, reject) => {
        try {
          const tx = db.transaction(name, 'readwrite');
          const store = tx.objectStore(name);
          const req = store.put(item);
          req.onsuccess = e => resolve(e.target.result);
          req.onerror = e => reject(e.target.error || e);
        } catch (err) { reject(err); }
      });
    },
    async deleteItem(storeName, id) {
      const name = this._normalizeStoreName(storeName);
      const db = await this._validateStore(name);
      return new Promise((resolve, reject) => {
        try {
          const tx = db.transaction(name, 'readwrite');
          const store = tx.objectStore(name);
          const req = store.delete(Number(id));
          req.onsuccess = () => resolve();
          req.onerror = e => reject(e.target.error || e);
        } catch (err) { reject(err); }
      });
    }
  };

  // If a DB exists but is missing some stores, reopen with version+1 and create them
  function createMissingStores(db, wantedStores) {
    return new Promise((resolve, reject) => {
      try {
        const missing = (wantedStores || []).filter(s => !db.objectStoreNames.contains(s));
        if (!missing.length) return resolve(db);
        const newVersion = db.version + 1;
        db.close();
        const req = indexedDB.open(TARGET_NAME, newVersion);
        req.onupgradeneeded = (e) => {
          const d = e.target.result;
          missing.forEach(name => {
            if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
          });
        };
        req.onsuccess = (e) => { const nd = e.target.result; nd.onversionchange = () => { try { nd.close(); } catch (err) {} }; window.hiveDB = nd; resolve(nd); };
        req.onerror = (e) => reject(e.target.error || e);
      } catch (err) { reject(err); }
    });
  }

  // expose
  window.dbHelpers = window.dbHelpers || dbHelpers;

  // Initialize once and attach to helpers
  ensureDB().then(db => {
    dbHelpers.db = db;
    window.hiveDB = db;
    console.log('db.js: hivedb ready, stores=', Array.from(db.objectStoreNames));
  }).catch(err => console.error('db.js: failed to open unified DB', err));
})();
