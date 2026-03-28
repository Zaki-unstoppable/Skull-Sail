// ─── Pirate 3D Asset Pipeline ───
// Global namespace: window.AssetPipeline
// Three.js r128 (global THREE), GLTFLoader via CDN
// All external API calls are proxied through http://localhost:3001/api/

(function(){
'use strict';

const C = window.PipelineConfig || {};
const API = (C.PROXY_BASE || 'http://localhost:3001/api');
const SOURCE_PRIORITY = C.SOURCE_PRIORITY || ['local_cache','sketchfab','ambientcg','polyhaven','meshy'];
const CATEGORY_BUDGETS = C.CATEGORY_BUDGETS || {};
const STYLE_FILTERS = C.STYLE_FILTERS || {include:[],exclude:[]};
const ZONE_TYPES = C.ZONE_TYPES || {};

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function cacheKey(source, assetId) {
  return `${source}:${assetId}`;
}

/**
 * Simple seeded PRNG (mulberry32) for deterministic NPC placement.
 * @param {number} seed
 * @returns {function(): number} — returns values in [0, 1)
 */
function seededRandom(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fetch JSON from the proxy, swallowing network / non-OK errors.
 * @param {string} url
 * @returns {Promise<any|null>}
 */
async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn(`[assets] fetch failed: ${url}`, err.message);
    return null;
  }
}

/**
 * Fetch an ArrayBuffer from the proxy.
 * @param {string} url
 * @returns {Promise<ArrayBuffer|null>}
 */
async function fetchBuffer(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch (err) {
    console.warn(`[assets] buffer fetch failed: ${url}`, err.message);
    return null;
  }
}

/**
 * Fetch a Blob from the proxy.
 * @param {string} url
 * @returns {Promise<Blob|null>}
 */
async function fetchBlob(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.blob();
  } catch (err) {
    console.warn(`[assets] blob fetch failed: ${url}`, err.message);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 1. AssetCache
// ───────────────────────────────────────────────────────────────────────────

const IDB_NAME = 'pirate3d-assets';
const IDB_VERSION = 1;
const IDB_STORE = 'assets';

/**
 * In-memory LRU with IndexedDB persistence.
 */
class AssetCache {
  constructor() {
    /** @type {Map<string, {data: any, metadata: any}>} */
    this._mem = new Map();
    /** @type {IDBDatabase|null} */
    this._db = null;
    this._dbReady = this._openDB();
  }

  /* ── IndexedDB bootstrap ── */

  /** @returns {Promise<IDBDatabase>} */
  _openDB() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        console.warn('[AssetCache] IndexedDB unavailable — memory-only mode');
        resolve(null);
        return;
      }
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => {
        this._db = req.result;
        resolve(this._db);
      };
      req.onerror = () => {
        console.warn('[AssetCache] IndexedDB open error', req.error);
        resolve(null);
      };
    });
  }

  /** Ensure DB is ready before IDB operations */
  async _ensureDB() {
    if (!this._db) await this._dbReady;
    return this._db;
  }

  /**
   * Retrieve an asset from cache (memory first, then IDB).
   * @param {string} key — e.g. "sketchfab:abc123"
   * @returns {Promise<{data: any, metadata: any}|null>}
   */
  async get(key) {
    if (this._mem.has(key)) return this._mem.get(key);

    const db = await this._ensureDB();
    if (!db) return null;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const req = store.get(key);
        req.onsuccess = () => {
          const val = req.result ?? null;
          if (val) this._mem.set(key, val);
          resolve(val);
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * Store an asset in both memory and IDB.
   * @param {string} key
   * @param {ArrayBuffer|Blob|any} data
   * @param {object} metadata
   */
  async set(key, data, metadata = {}) {
    const entry = { data, metadata, cachedAt: Date.now() };
    this._mem.set(key, entry);

    const db = await this._ensureDB();
    if (!db) return;

    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(entry, key);
    } catch (err) {
      console.warn('[AssetCache] IDB write error', err.message);
    }
  }

  /**
   * Check if a key exists in memory cache (fast path).
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this._mem.has(key);
  }

  /** Clear both memory and IDB stores. */
  async clear() {
    this._mem.clear();
    const db = await this._ensureDB();
    if (!db) return;
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).clear();
    } catch (err) {
      console.warn('[AssetCache] IDB clear error', err.message);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 2. AssetMetadataRegistry
// ───────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} AssetEntry
 * @property {string} id
 * @property {string} source
 * @property {string} title
 * @property {string} author
 * @property {string} license
 * @property {string} sourceUrl
 * @property {string} zoneTag
 * @property {string} category
 * @property {number} triangleCount
 * @property {number} score
 * @property {string} placementReason
 * @property {string} [fallbackReason]
 */

class AssetMetadataRegistry {
  constructor() {
    /** @type {Map<string, AssetEntry>} */
    this._entries = new Map();
  }

  /**
   * Register an asset entry.
   * @param {AssetEntry} entry
   */
  register(entry) {
    const key = cacheKey(entry.source, entry.id);
    this._entries.set(key, { ...entry });
    console.info(`[registry] registered ${entry.source}:${entry.id} — "${entry.title}"`);
  }

  /**
   * Get all entries tagged for a specific zone.
   * @param {string} zoneTag
   * @returns {AssetEntry[]}
   */
  getByZone(zoneTag) {
    return [...this._entries.values()].filter((e) => e.zoneTag === zoneTag);
  }

  /**
   * Get all entries in a category.
   * @param {string} cat
   * @returns {AssetEntry[]}
   */
  getByCategory(cat) {
    return [...this._entries.values()].filter((e) => e.category === cat);
  }

  /**
   * Build a human-readable attribution string for all third-party assets.
   * @returns {string}
   */
  exportAttribution() {
    const lines = ['=== Third-Party Asset Attributions ===', ''];
    for (const e of this._entries.values()) {
      lines.push(`• "${e.title}" by ${e.author || 'Unknown'}`);
      lines.push(`  Source: ${e.source} | License: ${e.license || 'Unknown'}`);
      if (e.sourceUrl) lines.push(`  URL: ${e.sourceUrl}`);
      lines.push('');
    }
    if (lines.length === 2) lines.push('(no third-party assets registered)');
    return lines.join('\n');
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 3. AssetScoringService
// ───────────────────────────────────────────────────────────────────────────

const PIRATE_KEYWORDS = [
  'wood', 'rope', 'sail', 'metal', 'stone', 'sand', 'tropical', 'medieval',
  'pirate', 'nautical', 'ship', 'cannon', 'barrel', 'crate', 'rustic',
  'weathered', 'colonial', 'treasure', 'anchor', 'helm', 'plank', 'cobblestone',
  'thatched', 'sandstone', 'palm', 'ocean', 'coast', 'dock', 'wharf', 'lantern',
  'torch', 'skull', 'cutlass', 'galleon', 'sloop', 'brigantine', 'rum',
  ...STYLE_FILTERS.include,
];
const PIRATE_KEYWORD_SET = new Set(PIRATE_KEYWORDS.map((k) => k.toLowerCase()));

const ANTI_KEYWORDS = [
  'futuristic', 'modern', 'plastic', 'sci-fi', 'scifi', 'cyberpunk', 'neon',
  'electronic', 'digital', 'robot', 'mech', 'skyscraper', 'concrete',
  ...STYLE_FILTERS.exclude,
];
const ANTI_KEYWORD_SET = new Set(ANTI_KEYWORDS.map((k) => k.toLowerCase()));

class AssetScoringService {
  /**
   * Score an asset from 0-100.
   *
   * @param {object} assetMeta — must include title, tags (array|string), triangleCount, hasTextures, materialType
   * @param {object} requirements — { category, maxTriangles, preferredScale, requiredMaps }
   * @returns {{total: number, breakdown: object}}
   */
  score(assetMeta, requirements = {}) {
    const breakdown = {
      visualQuality: this._scoreVisualQuality(assetMeta),
      styleMatch: this._scoreStyleMatch(assetMeta),
      scaleMatch: this._scoreScaleMatch(assetMeta, requirements),
      polygonBudget: this._scorePolygonBudget(assetMeta, requirements),
      textureCompleteness: this._scoreTextureCompleteness(assetMeta, requirements),
      materialCompatibility: this._scoreMaterialCompatibility(assetMeta),
    };
    const total = Object.values(breakdown).reduce((s, v) => s + v, 0);
    return { total: Math.round(total), breakdown };
  }

  /** Visual quality 0-25: based on like count, view count, and texture presence */
  _scoreVisualQuality(meta) {
    let s = 0;
    if (meta.likeCount > 100) s += 10;
    else if (meta.likeCount > 10) s += 6;
    else s += 2;

    if (meta.hasTextures !== false) s += 8;
    if (meta.viewCount > 1000) s += 4;
    else if (meta.viewCount > 100) s += 2;

    if (meta.isAnimated) s += 3;
    return Math.min(25, s);
  }

  /** Style match 0-25: pirate-era keywords boost, modern keywords penalize */
  _scoreStyleMatch(meta) {
    const text = this._extractText(meta).toLowerCase();
    const tokens = text.split(/[\s,_\-/]+/);

    let hits = 0;
    let antiHits = 0;
    for (const tok of tokens) {
      if (PIRATE_KEYWORD_SET.has(tok)) hits++;
      if (ANTI_KEYWORD_SET.has(tok)) antiHits++;
    }

    const positiveScore = Math.min(25, hits * 5);
    const penalty = antiHits * 8;
    return Math.max(0, positiveScore - penalty);
  }

  /** Scale match 0-15: if asset dimensions are within expected range */
  _scoreScaleMatch(meta, req) {
    if (!req.preferredScale || !meta.dimensions) return 10; // neutral
    const { x, y, z } = meta.dimensions;
    const maxDim = Math.max(x || 0, y || 0, z || 0);
    if (maxDim === 0) return 8;
    const ratio = maxDim / req.preferredScale;
    if (ratio >= 0.5 && ratio <= 2.0) return 15;
    if (ratio >= 0.25 && ratio <= 4.0) return 10;
    return 5;
  }

  /** Polygon budget 0-15: full if under budget, linear falloff to 0 at 2x */
  _scorePolygonBudget(meta, req) {
    const budget = req.maxTriangles || CATEGORY_BUDGETS[req.category] || 10000;
    const count = meta.triangleCount || 0;
    if (count === 0) return 8; // unknown
    if (count <= budget) return 15;
    if (count >= budget * 2) return 0;
    // linear falloff between budget and 2*budget
    return Math.round(15 * (1 - (count - budget) / budget));
  }

  /** Texture completeness 0-10 */
  _scoreTextureCompleteness(meta, req) {
    if (!meta.textureMaps) return 5;
    const required = req.requiredMaps || ['albedo', 'normal'];
    const present = new Set(
      (Array.isArray(meta.textureMaps) ? meta.textureMaps : Object.keys(meta.textureMaps))
        .map((m) => m.toLowerCase())
    );
    let matched = 0;
    for (const m of required) {
      if (present.has(m) || present.has(m.replace('albedo', 'diffuse')) || present.has(m.replace('albedo', 'color'))) {
        matched++;
      }
    }
    return Math.round((matched / Math.max(required.length, 1)) * 10);
  }

  /** Material compatibility 0-10 */
  _scoreMaterialCompatibility(meta) {
    const matType = (meta.materialType || '').toLowerCase();
    if (matType.includes('pbr') || matType.includes('standard')) return 10;
    if (matType.includes('phong') || matType.includes('lambert')) return 7;
    if (!matType) return 5;
    return 3;
  }

  /** Combine title, description, and tags into searchable text */
  _extractText(meta) {
    const parts = [meta.title || '', meta.description || ''];
    if (Array.isArray(meta.tags)) parts.push(meta.tags.join(' '));
    else if (typeof meta.tags === 'string') parts.push(meta.tags);
    return parts.join(' ');
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 4. AssetSearchService
// ───────────────────────────────────────────────────────────────────────────

class AssetSearchService {
  /**
   * @param {AssetCache} cache
   * @param {AssetScoringService} scorer
   */
  constructor(cache, scorer) {
    this._cache = cache;
    this._scorer = scorer;
  }

  /**
   * Search for assets across all sources in priority order.
   *
   * @param {string} query — search term
   * @param {string} category — asset category (prop, texture, character, …)
   * @param {object} [options]
   * @param {number} [options.minScore=20] — minimum style score to include
   * @param {number} [options.limit=20]
   * @param {string} [options.sortBy='score']
   * @returns {Promise<Array<{source, id, title, author, license, thumbnailUrl, downloadUrl, meta}>>}
   */
  async search(query, category, options = {}) {
    const { minScore = 20, limit = 20 } = options;

    const results = [];

    // 1. Local cache scan
    const cached = this._searchCache(query, category);
    results.push(...cached);

    // 2. Sketchfab (models)
    if (category !== 'texture') {
      const sfResults = await this._searchSketchfab(query);
      results.push(...sfResults);
    }

    // 3. ambientCG (textures / materials)
    if (category === 'texture' || category === 'material') {
      const acgResults = await this._searchAmbientCG(query);
      results.push(...acgResults);
    }

    // 4. Poly Haven (textures)
    if (category === 'texture' || category === 'material') {
      const phResults = await this._searchPolyHaven(query);
      results.push(...phResults);
    }

    // Score and filter
    const scored = results.map((r) => {
      const s = this._scorer.score(r.meta, { category });
      return { ...r, meta: { ...r.meta, score: s.total, scoreBreakdown: s.breakdown } };
    });

    const filtered = scored.filter((r) => r.meta.score >= minScore);
    filtered.sort((a, b) => b.meta.score - a.meta.score);

    return filtered.slice(0, limit);
  }

  /* ── Source-specific search helpers ── */

  _searchCache(query, category) {
    const results = [];
    const q = query.toLowerCase();
    for (const [key, entry] of this._cache._mem) {
      const meta = entry.metadata || {};
      const text = `${meta.title || ''} ${meta.category || ''} ${(meta.tags || []).join(' ')}`.toLowerCase();
      if (text.includes(q) && (!category || meta.category === category)) {
        results.push({
          source: 'local_cache',
          id: key,
          title: meta.title || key,
          author: meta.author || 'cached',
          license: meta.license || 'unknown',
          thumbnailUrl: null,
          downloadUrl: null,
          meta: { ...meta, fromCache: true },
        });
      }
    }
    return results;
  }

  async _searchSketchfab(query) {
    const url = `${API}/sketchfab/search?type=models&q=${encodeURIComponent(query)}&downloadable=true&categories=cultural-heritage-history&sort_by=-likeCount`;
    const data = await fetchJSON(url);
    if (!data || !data.results) return [];

    return data.results.map((r) => ({
      source: 'sketchfab',
      id: r.uid,
      title: r.name || 'Untitled',
      author: r.user?.displayName || r.user?.username || 'Unknown',
      license: r.license?.label || r.license?.slug || 'unknown',
      thumbnailUrl: r.thumbnails?.images?.[0]?.url || null,
      downloadUrl: null, // download requires a separate API call
      meta: {
        title: r.name,
        description: r.description || '',
        tags: (r.tags || []).map((t) => t.name || t),
        likeCount: r.likeCount || 0,
        viewCount: r.viewCount || 0,
        triangleCount: r.faceCount ? r.faceCount * 2 : 0,
        isAnimated: r.isAnimated || false,
        hasTextures: true,
        materialType: 'pbr',
      },
    }));
  }

  async _searchAmbientCG(query) {
    const url = `${API}/ambientcg?type=Material&q=${encodeURIComponent(query)}&sort=Popular&limit=10&include=downloadData`;
    const data = await fetchJSON(url);
    if (!data || !data.foundAssets) return [];

    return data.foundAssets.map((a) => {
      const downloads = a.downloadFolders?.default?.downloadFiletypeCategories?.zip?.downloads || [];
      const preferred = downloads.find((d) => d.attribute === '2K') || downloads.find((d) => d.attribute === '1K') || downloads[0];
      return {
        source: 'ambientcg',
        id: a.assetId,
        title: a.displayName || a.assetId,
        author: 'ambientCG',
        license: 'CC0 1.0',
        thumbnailUrl: a.previewImage?.['256-PNG'] || null,
        downloadUrl: preferred?.fullDownloadPath || null,
        meta: {
          title: a.displayName || a.assetId,
          tags: a.tags || [],
          category: 'texture',
          hasTextures: true,
          textureMaps: ['albedo', 'normal', 'roughness', 'ao', 'displacement'],
          materialType: 'pbr',
          likeCount: a.downloadCount || 0,
          viewCount: 0,
        },
      };
    });
  }

  async _searchPolyHaven(query) {
    const url = `${API}/polyhaven/assets?t=textures&categories=outdoor,wood,stone,sand`;
    const data = await fetchJSON(url);
    if (!data) return [];

    const q = query.toLowerCase();
    const entries = Object.entries(data);
    const matched = entries.filter(([key, val]) => {
      const text = `${key} ${val.name || ''} ${(val.tags || []).join(' ')} ${(val.categories || []).join(' ')}`.toLowerCase();
      return text.includes(q);
    });

    return matched.slice(0, 10).map(([key, val]) => ({
      source: 'polyhaven',
      id: key,
      title: val.name || key,
      author: val.authors ? Object.keys(val.authors).join(', ') : 'Poly Haven',
      license: 'CC0 1.0',
      thumbnailUrl: `https://cdn.polyhaven.com/asset_img/thumbs/${key}.png`,
      downloadUrl: null, // constructed at download time
      meta: {
        title: val.name || key,
        tags: val.tags || [],
        category: 'texture',
        hasTextures: true,
        textureMaps: ['albedo', 'normal', 'roughness', 'ao', 'displacement'],
        materialType: 'pbr',
        likeCount: val.download_count || 0,
        viewCount: 0,
      },
    }));
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 5. AssetDownloadService
// ───────────────────────────────────────────────────────────────────────────

class AssetDownloadService {
  /**
   * @param {AssetCache} cache
   */
  constructor(cache) {
    this._cache = cache;
  }

  /**
   * Download an asset from the specified source.
   *
   * @param {string} source — 'sketchfab' | 'ambientcg' | 'polyhaven'
   * @param {string} assetId
   * @param {string} [format='glb'] — desired file format
   * @returns {Promise<{data: ArrayBuffer|Blob, metadata: object}|null>}
   */
  async download(source, assetId, format = 'glb') {
    const key = cacheKey(source, assetId);

    // Check cache first
    const cached = await this._cache.get(key);
    if (cached) {
      console.info(`[download] cache hit for ${key}`);
      return cached;
    }

    let result = null;

    switch (source) {
      case 'sketchfab':
        result = await this._downloadSketchfab(assetId, format);
        break;
      case 'ambientcg':
        result = await this._downloadAmbientCG(assetId);
        break;
      case 'polyhaven':
        result = await this._downloadPolyHaven(assetId);
        break;
      default:
        console.warn(`[download] unknown source: ${source}`);
        return null;
    }

    if (result) {
      await this._cache.set(key, result.data, result.metadata);
      console.info(`[download] cached ${key} (${(result.data.byteLength || result.data.size || 0)} bytes)`);
    }

    return result;
  }

  async _downloadSketchfab(uid, format) {
    const url = `${API}/sketchfab/download/${uid}`;
    const data = await fetchBuffer(url);
    if (!data) return null;
    return {
      data,
      metadata: { source: 'sketchfab', id: uid, format: format || 'glb', downloadedAt: Date.now() },
    };
  }

  async _downloadAmbientCG(assetId) {
    // Fetch asset info to get download links
    const infoUrl = `${API}/ambientcg?type=Material&q=${encodeURIComponent(assetId)}&sort=Popular&limit=1&include=downloadData`;
    const info = await fetchJSON(infoUrl);
    if (!info?.foundAssets?.length) return null;

    const asset = info.foundAssets[0];
    const downloads = asset.downloadFolders?.default?.downloadFiletypeCategories?.zip?.downloads || [];
    const preferred = downloads.find((d) => d.attribute === '2K')
      || downloads.find((d) => d.attribute === '1K')
      || downloads[0];

    if (!preferred?.fullDownloadPath) return null;

    const data = await fetchBlob(preferred.fullDownloadPath);
    if (!data) return null;

    return {
      data,
      metadata: {
        source: 'ambientcg',
        id: assetId,
        resolution: preferred.attribute,
        format: 'zip',
        title: asset.displayName || assetId,
        downloadedAt: Date.now(),
      },
    };
  }

  async _downloadPolyHaven(assetId) {
    // Fetch the asset info to construct download URLs
    const infoUrl = `${API}/polyhaven/assets?t=textures&categories=outdoor,wood,stone,sand`;
    const allAssets = await fetchJSON(infoUrl);
    if (!allAssets || !allAssets[assetId]) return null;

    // Download the 2K diffuse map as a representative file
    const mapUrl = `https://dl.polyhaven.org/file/ph-assets/Textures/${assetId}/2k/${assetId}_diff_2k.jpg`;
    const data = await fetchBlob(mapUrl);
    if (!data) return null;

    return {
      data,
      metadata: {
        source: 'polyhaven',
        id: assetId,
        resolution: '2k',
        format: 'jpg',
        title: allAssets[assetId].name || assetId,
        downloadedAt: Date.now(),
      },
    };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 6. TextureImportService
// ───────────────────────────────────────────────────────────────────────────

class TextureImportService {
  /**
   * @param {AssetDownloadService} downloader
   */
  constructor(downloader) {
    this._downloader = downloader;
    this._loader = new THREE.TextureLoader();
  }

  /**
   * Import PBR texture maps for an asset, returning a material-ready set.
   *
   * @param {string} source
   * @param {string} assetId
   * @param {object} maps — map name → URL or Blob. Keys: albedo, normal, roughness, metalness, ao, displacement
   * @returns {Promise<{albedo: THREE.Texture, normal: THREE.Texture, roughness: THREE.Texture, metalness: THREE.Texture, ao: THREE.Texture, displacement: THREE.Texture}>}
   */
  async importTexture(source, assetId, maps = {}) {
    console.info(`[texture] importing PBR set for ${source}:${assetId}`);

    const result = {};
    const mapNames = ['albedo', 'normal', 'roughness', 'metalness', 'ao', 'displacement'];

    const loadPromises = mapNames.map(async (name) => {
      const src = maps[name];
      if (!src) {
        result[name] = null;
        return;
      }

      try {
        const texture = await this._loadTexture(src);
        this._configureTexture(texture, name);
        result[name] = texture;
      } catch (err) {
        console.warn(`[texture] failed to load ${name} map for ${assetId}:`, err.message);
        result[name] = null;
      }
    });

    await Promise.all(loadPromises);
    return result;
  }

  /**
   * Load a texture from a URL string or Blob.
   * @param {string|Blob} src
   * @returns {Promise<THREE.Texture>}
   */
  _loadTexture(src) {
    return new Promise((resolve, reject) => {
      if (src instanceof Blob) {
        const url = URL.createObjectURL(src);
        this._loader.load(
          url,
          (tex) => { URL.revokeObjectURL(url); resolve(tex); },
          undefined,
          (err) => { URL.revokeObjectURL(url); reject(err); }
        );
      } else {
        this._loader.load(src, resolve, undefined, reject);
      }
    });
  }

  /**
   * Apply correct encoding, wrapping, and filtering for each map type.
   * @param {THREE.Texture} texture
   * @param {string} mapType
   */
  _configureTexture(texture, mapType) {
    // Wrapping
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1, 1);

    // Encoding — sRGB for color data, Linear for data maps
    if (mapType === 'albedo') {
      texture.encoding = THREE.sRGBEncoding;
    } else {
      texture.encoding = THREE.LinearEncoding;
    }

    // Filtering
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 4;

    texture.needsUpdate = true;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 7. ModelImportService
// ───────────────────────────────────────────────────────────────────────────

class ModelImportService {
  /**
   * @param {AssetDownloadService} downloader
   * @param {AssetScoringService} scorer
   */
  constructor(downloader, scorer) {
    this._downloader = downloader;
    this._scorer = scorer;
    this._gltfLoader = typeof GLTFLoader !== 'undefined' ? new GLTFLoader() : null;
  }

  /**
   * Import a 3D model, auto-scale it, apply shadows, and validate poly budget.
   *
   * @param {string} source
   * @param {string} assetId
   * @param {object} [options]
   * @param {number} [options.maxSize=5] — bounding box max dimension
   * @param {boolean} [options.castShadow=true]
   * @param {boolean} [options.receiveShadow=true]
   * @param {number} [options.maxTriangles] — triangle budget
   * @param {string} [options.category='prop']
   * @returns {Promise<{scene: THREE.Group, animations: Array, metadata: object}|null>}
   */
  async importModel(source, assetId, options = {}) {
    const {
      maxSize = 5,
      castShadow = true,
      receiveShadow = true,
      maxTriangles,
      category = 'prop',
    } = options;

    console.info(`[model] importing ${source}:${assetId}`);

    // Download the model data
    const downloaded = await this._downloader.download(source, assetId, 'glb');
    if (!downloaded) {
      console.warn(`[model] download failed for ${source}:${assetId}`);
      return null;
    }

    // Parse GLTF/GLB
    const gltf = await this._parseGLTF(downloaded.data);
    if (!gltf) return null;

    const scene = gltf.scene;

    // Validate triangle count
    const triCount = this._countTriangles(scene);
    const budget = maxTriangles || CATEGORY_BUDGETS[category] || 10000;
    if (triCount > budget * 2) {
      console.warn(`[model] ${source}:${assetId} exceeds 2x triangle budget (${triCount} > ${budget * 2})`);
    }

    // Auto-scale to fit bounding box
    this._autoScale(scene, maxSize);

    // Apply shadow settings
    scene.traverse((node) => {
      if (node.isMesh) {
        node.castShadow = castShadow;
        node.receiveShadow = receiveShadow;
      }
    });

    const metadata = {
      source,
      id: assetId,
      triangleCount: triCount,
      budget,
      overBudget: triCount > budget,
      ...downloaded.metadata,
    };

    console.info(`[model] loaded ${source}:${assetId} — ${triCount} triangles`);

    return {
      scene,
      animations: gltf.animations || [],
      metadata,
    };
  }

  /**
   * Parse a GLB/glTF ArrayBuffer using GLTFLoader.
   * @param {ArrayBuffer} buffer
   * @returns {Promise<object|null>}
   */
  _parseGLTF(buffer) {
    const loader = this._gltfLoader;
    if (!loader) {
      console.error('[model] GLTFLoader not available — load it from Three.js examples CDN');
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      loader.parse(
        buffer,
        '', // resource path
        (gltf) => resolve(gltf),
        (err) => {
          console.warn('[model] GLTF parse error:', err.message || err);
          resolve(null);
        }
      );
    });
  }

  /**
   * Count total triangles in a scene graph.
   * @param {THREE.Object3D} root
   * @returns {number}
   */
  _countTriangles(root) {
    let count = 0;
    root.traverse((node) => {
      if (node.isMesh && node.geometry) {
        const geo = node.geometry;
        if (geo.index) {
          count += geo.index.count / 3;
        } else if (geo.attributes.position) {
          count += geo.attributes.position.count / 3;
        }
      }
    });
    return Math.round(count);
  }

  /**
   * Scale a scene to fit within a bounding box of the given max size.
   * @param {THREE.Object3D} scene
   * @param {number} maxSize
   */
  _autoScale(scene, maxSize) {
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0 && maxDim !== maxSize) {
      const scale = maxSize / maxDim;
      scene.scale.multiplyScalar(scale);
    }
    // Center the model
    const center = new THREE.Vector3();
    box.getCenter(center);
    scene.position.sub(center.multiplyScalar(scene.scale.x));
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 8. CharacterImportService
// ───────────────────────────────────────────────────────────────────────────

/** Standard character heights by role (in world units). */
const CHARACTER_HEIGHTS = {
  player: 1.8,
  guard: 1.9,
  merchant: 1.7,
  civilian: 1.7,
  pirate: 1.85,
  worker: 1.75,
};

class CharacterImportService {
  /**
   * @param {ModelImportService} modelService
   */
  constructor(modelService) {
    this._modelService = modelService;
  }

  /**
   * Import a rigged character model, set up animations, and normalize scale.
   *
   * @param {string} source
   * @param {string} assetId
   * @param {string} role — 'player' | 'guard' | 'merchant' | 'civilian' | 'pirate' | 'worker'
   * @returns {Promise<{model: THREE.Group, mixer: THREE.AnimationMixer, animations: Map<string, THREE.AnimationClip>, skeleton: THREE.Skeleton|null}|null>}
   */
  async importCharacter(source, assetId, role = 'civilian') {
    console.info(`[character] importing ${role} from ${source}:${assetId}`);

    const targetHeight = CHARACTER_HEIGHTS[role] || 1.7;
    const minHeight = targetHeight * 0.9;
    const maxHeight = targetHeight * 1.1;

    const result = await this._modelService.importModel(source, assetId, {
      maxSize: targetHeight,
      castShadow: true,
      receiveShadow: false,
      category: role === 'player' ? 'character' : 'npc',
    });

    if (!result) return null;

    const { scene, animations, metadata } = result;

    // Normalize to exact role height
    this._normalizeHeight(scene, targetHeight);

    // Find skeleton
    let skeleton = null;
    scene.traverse((node) => {
      if (node.isSkinnedMesh && node.skeleton) {
        skeleton = node.skeleton;
      }
    });

    if (!skeleton) {
      console.warn(`[character] no skeleton found in ${source}:${assetId} — character may not animate`);
    }

    // Set up AnimationMixer and clip map
    const mixer = new THREE.AnimationMixer(scene);
    const animMap = new Map();
    for (const clip of animations) {
      const name = clip.name.toLowerCase().replace(/[\s_]+/g, '_');
      animMap.set(name, clip);
    }

    console.info(`[character] ${role} loaded — ${animations.length} animation(s), skeleton: ${!!skeleton}`);

    return {
      model: scene,
      mixer,
      animations: animMap,
      skeleton,
    };
  }

  /**
   * Normalize character height to the target value.
   * @param {THREE.Object3D} scene
   * @param {number} targetHeight
   */
  _normalizeHeight(scene, targetHeight) {
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    if (size.y > 0) {
      const scale = targetHeight / size.y;
      scene.scale.multiplyScalar(scale);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 9. NPCPopulationService
// ───────────────────────────────────────────────────────────────────────────

/** NPC role distributions per zone type */
const ZONE_NPC_CONFIG = {
  fort_zone: {
    roles: [
      { role: 'guard', weight: 0.5, behavior: 'patrol' },
      { role: 'worker', weight: 0.3, behavior: 'operate_cannon' },
      { role: 'guard', weight: 0.2, behavior: 'lookout' },
    ],
  },
  village_zone: {
    roles: [
      { role: 'civilian', weight: 0.35, behavior: 'wander' },
      { role: 'merchant', weight: 0.25, behavior: 'tend_shop' },
      { role: 'worker', weight: 0.2, behavior: 'fish' },
      { role: 'worker', weight: 0.2, behavior: 'work_dock' },
    ],
  },
  port: {
    roles: [
      { role: 'worker', weight: 0.35, behavior: 'work_dock' },
      { role: 'merchant', weight: 0.3, behavior: 'trade' },
      { role: 'pirate', weight: 0.2, behavior: 'idle' },
      { role: 'civilian', weight: 0.15, behavior: 'wander' },
    ],
  },
  ruins_zone: {
    roles: [
      { role: 'pirate', weight: 1.0, behavior: 'patrol_hostile' },
    ],
  },
};

class NPCPopulationService {
  /**
   * @param {CharacterImportService} characterService
   * @param {AssetSearchService} searchService
   */
  constructor(characterService, searchService) {
    this._charService = characterService;
    this._searchService = searchService;
  }

  /**
   * Populate a zone with NPCs based on zone type and density.
   *
   * @param {object} island — island data with: seed (number), terrain (heightmap or function), bounds ({min, max})
   * @param {string} zoneTag — zone type key
   * @param {number} [density=0.5] — 0-1, fraction of maximum NPCs to place
   * @returns {Promise<Array<{model: THREE.Group, position: THREE.Vector3, role: string, behavior: string}>>}
   */
  async populateZone(island, zoneTag, density = 0.5) {
    const config = ZONE_NPC_CONFIG[zoneTag];
    if (!config) {
      console.warn(`[npc] unknown zone type: ${zoneTag}`);
      return [];
    }

    const maxNPCs = Math.round(density * 20);
    const rng = seededRandom(island.seed || 42 + zoneTag.length);
    const npcs = [];

    // Determine how many NPCs of each role
    const assignments = this._assignRoles(config.roles, maxNPCs, rng);

    for (const { role, behavior } of assignments) {
      // Search for a suitable character model
      const searchResults = await this._searchService.search(
        `${role} pirate era character`,
        'character',
        { limit: 3, minScore: 10 }
      );

      let charResult = null;
      for (const sr of searchResults) {
        try {
          charResult = await this._charService.importCharacter(sr.source, sr.id, role);
          if (charResult) break;
        } catch (err) {
          console.warn(`[npc] failed to import character ${sr.id}:`, err.message);
        }
      }

      if (!charResult) {
        console.warn(`[npc] no suitable model found for ${role} in ${zoneTag}, creating placeholder`);
        charResult = { model: this._createPlaceholder(role), mixer: null, animations: new Map(), skeleton: null };
      }

      // Position the NPC within the zone bounds
      const position = this._computePosition(island, zoneTag, rng);

      // Face a logical direction
      const facing = this._computeFacing(behavior, position, island, rng);
      charResult.model.rotation.y = facing;

      npcs.push({
        model: charResult.model,
        position,
        role,
        behavior,
      });
    }

    console.info(`[npc] populated ${zoneTag} with ${npcs.length} NPCs`);
    return npcs;
  }

  /**
   * Distribute NPC roles weighted by config.
   * @param {Array} roleConfigs
   * @param {number} count
   * @param {function} rng
   * @returns {Array<{role: string, behavior: string}>}
   */
  _assignRoles(roleConfigs, count, rng) {
    const assignments = [];
    for (let i = 0; i < count; i++) {
      const r = rng();
      let cumulative = 0;
      for (const rc of roleConfigs) {
        cumulative += rc.weight;
        if (r <= cumulative) {
          assignments.push({ role: rc.role, behavior: rc.behavior });
          break;
        }
      }
    }
    return assignments;
  }

  /**
   * Compute a position within the zone using deterministic RNG.
   * @param {object} island
   * @param {string} zoneTag
   * @param {function} rng
   * @returns {THREE.Vector3}
   */
  _computePosition(island, zoneTag, rng) {
    const bounds = island.bounds || { min: { x: -50, z: -50 }, max: { x: 50, z: 50 } };
    const x = bounds.min.x + rng() * (bounds.max.x - bounds.min.x);
    const z = bounds.min.z + rng() * (bounds.max.z - bounds.min.z);

    // Sample terrain height if available
    let y = 0;
    if (typeof island.getHeight === 'function') {
      y = island.getHeight(x, z);
    } else if (island.terrainY !== undefined) {
      y = island.terrainY;
    }

    return new THREE.Vector3(x, y, z);
  }

  /**
   * Compute a Y rotation based on behavior context.
   * @param {string} behavior
   * @param {THREE.Vector3} position
   * @param {object} island
   * @param {function} rng
   * @returns {number} — radians
   */
  _computeFacing(behavior, position, island, rng) {
    // Special behaviors face specific directions
    if (behavior === 'lookout' || behavior === 'fish') {
      // Face outward (toward the sea — assume center of island is origin)
      return Math.atan2(position.x, position.z);
    }
    if (behavior === 'tend_shop' || behavior === 'trade') {
      // Face toward center of activity (0,0)
      return Math.atan2(-position.x, -position.z);
    }
    // Random facing for patrol / wander
    return rng() * Math.PI * 2;
  }

  /**
   * Create a simple placeholder mesh for an NPC when no model is available.
   * @param {string} role
   * @returns {THREE.Group}
   */
  _createPlaceholder(role) {
    const height = CHARACTER_HEIGHTS[role] || 1.7;
    const group = new THREE.Group();
    group.name = `placeholder_${role}`;

    // Body capsule
    const bodyGeo = new THREE.CylinderGeometry(0.25, 0.25, height * 0.6, 8);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x8b6914, roughness: 0.8 });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = height * 0.4;
    body.castShadow = true;
    group.add(body);

    // Head sphere
    const headGeo = new THREE.SphereGeometry(0.18, 8, 6);
    const headMat = new THREE.MeshStandardMaterial({ color: 0xd2a679, roughness: 0.7 });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = height * 0.8;
    head.castShadow = true;
    group.add(head);

    return group;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 10. InventoryModelService
// ───────────────────────────────────────────────────────────────────────────

/** Item configuration: search queries and display/equip scales */
const ITEM_CONFIG = {
  shovel: { query: 'pirate shovel', displayScale: 0.3, equipScale: 0.8 },
  sword: { query: 'pirate cutlass sword', displayScale: 0.3, equipScale: 0.9 },
  compass: { query: 'old nautical compass', displayScale: 0.2, equipScale: 0.15 },
  spyglass: { query: 'pirate spyglass telescope', displayScale: 0.25, equipScale: 0.6 },
  treasure_map: { query: 'old treasure map scroll', displayScale: 0.2, equipScale: 0.35 },
  gold_pouch: { query: 'gold coin pouch medieval', displayScale: 0.2, equipScale: 0.2 },
};

class InventoryModelService {
  /**
   * @param {AssetSearchService} searchService
   * @param {ModelImportService} modelService
   */
  constructor(searchService, modelService) {
    this._searchService = searchService;
    this._modelService = modelService;
    /** @type {Map<string, THREE.Group>} */
    this._itemCache = new Map();
  }

  /**
   * Get a model for inventory display (smaller scale, centered).
   *
   * @param {string} itemName — one of: shovel, sword, compass, spyglass, treasure_map, gold_pouch
   * @returns {Promise<THREE.Group>}
   */
  async getItemModel(itemName) {
    const cacheKey = `display:${itemName}`;
    if (this._itemCache.has(cacheKey)) return this._itemCache.get(cacheKey).clone();

    const config = ITEM_CONFIG[itemName];
    if (!config) {
      console.warn(`[inventory] unknown item: ${itemName}`);
      return this._createFallbackItem(itemName, 0.3);
    }

    const model = await this._loadItem(itemName, config.displayScale);
    this._itemCache.set(cacheKey, model);
    return model.clone();
  }

  /**
   * Get a model for equip display (hand-held scale).
   *
   * @param {string} itemName
   * @returns {Promise<THREE.Group>}
   */
  async getEquipModel(itemName) {
    const cacheKey = `equip:${itemName}`;
    if (this._itemCache.has(cacheKey)) return this._itemCache.get(cacheKey).clone();

    const config = ITEM_CONFIG[itemName];
    if (!config) {
      console.warn(`[inventory] unknown item: ${itemName}`);
      return this._createFallbackItem(itemName, 0.8);
    }

    const model = await this._loadItem(itemName, config.equipScale);
    this._itemCache.set(cacheKey, model);
    return model.clone();
  }

  /**
   * Search for an item model, download, import, and scale it.
   * @param {string} itemName
   * @param {number} targetScale
   * @returns {Promise<THREE.Group>}
   */
  async _loadItem(itemName, targetScale) {
    const config = ITEM_CONFIG[itemName];

    // Search sources in priority: cache → sketchfab → fallback
    const results = await this._searchService.search(config.query, 'prop', {
      minScore: 15,
      limit: 5,
    });

    for (const sr of results) {
      try {
        const imported = await this._modelService.importModel(sr.source, sr.id, {
          maxSize: targetScale,
          castShadow: false,
          receiveShadow: false,
          category: 'inventory',
        });
        if (imported) {
          imported.scene.name = `item_${itemName}`;
          console.info(`[inventory] loaded ${itemName} from ${sr.source}:${sr.id}`);
          return imported.scene;
        }
      } catch (err) {
        console.warn(`[inventory] failed to load ${itemName} from ${sr.id}:`, err.message);
      }
    }

    console.info(`[inventory] using fallback for ${itemName}`);
    return this._createFallbackItem(itemName, targetScale);
  }

  /**
   * Create a simple procedural placeholder for an inventory item.
   * @param {string} itemName
   * @param {number} scale
   * @returns {THREE.Group}
   */
  _createFallbackItem(itemName, scale) {
    const group = new THREE.Group();
    group.name = `fallback_${itemName}`;
    const mat = new THREE.MeshStandardMaterial({ color: 0xc4a35a, roughness: 0.6, metalness: 0.3 });

    switch (itemName) {
      case 'sword': {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.8, 0.01), mat);
        blade.position.y = 0.4;
        group.add(blade);
        const hilt = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 0.04), new THREE.MeshStandardMaterial({ color: 0x5c3a1e, roughness: 0.9 }));
        group.add(hilt);
        break;
      }
      case 'shovel': {
        const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.8, 6), new THREE.MeshStandardMaterial({ color: 0x6b4226, roughness: 0.9 }));
        handle.position.y = 0.4;
        group.add(handle);
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.18, 0.02), mat);
        head.position.y = 0.05;
        group.add(head);
        break;
      }
      case 'compass': {
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 16), mat);
        group.add(body);
        const needle = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.005, 0.005), new THREE.MeshStandardMaterial({ color: 0xff0000 }));
        needle.position.y = 0.015;
        group.add(needle);
        break;
      }
      case 'spyglass': {
        const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.5, 12), mat);
        tube.rotation.z = Math.PI / 2;
        group.add(tube);
        break;
      }
      case 'treasure_map': {
        const scroll = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.01, 0.22), new THREE.MeshStandardMaterial({ color: 0xd4b483, roughness: 1.0 }));
        group.add(scroll);
        break;
      }
      case 'gold_pouch': {
        const pouch = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), new THREE.MeshStandardMaterial({ color: 0x8b6914, roughness: 0.9 }));
        group.add(pouch);
        break;
      }
      default: {
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.15), mat);
        group.add(box);
      }
    }

    // Scale the entire group
    const targetDim = scale;
    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0) group.scale.multiplyScalar(targetDim / maxDim);

    return group;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 11. DisasterAssetService
// ───────────────────────────────────────────────────────────────────────────

class DisasterAssetService {
  /**
   * @param {AssetSearchService} searchService
   * @param {ModelImportService} modelService
   */
  constructor(searchService, modelService) {
    this._searchService = searchService;
    this._modelService = modelService;
  }

  /**
   * Get game-ready disaster visuals for a specific type.
   *
   * @param {string} type — 'whirlpool' | 'tornado' | 'typhoon' | 'dark_clouds' | 'rain_clouds'
   * @returns {Promise<{model: THREE.Group, particles: Array, lights: Array}>}
   */
  async getDisasterVisuals(type) {
    console.info(`[disaster] loading visuals for ${type}`);

    // Try to find a premade VFX-ready model first
    const searchResults = await this._searchService.search(
      `${type} effect vfx`,
      'disaster',
      { minScore: 10, limit: 3 }
    );

    for (const sr of searchResults) {
      try {
        const imported = await this._modelService.importModel(sr.source, sr.id, {
          maxSize: 10,
          castShadow: false,
          receiveShadow: false,
          category: 'disaster',
        });
        if (imported) {
          const extras = this._buildDisasterExtras(type);
          console.info(`[disaster] loaded ${type} from ${sr.source}:${sr.id}`);
          return { model: imported.scene, ...extras };
        }
      } catch (err) {
        console.warn(`[disaster] failed to load ${type} from ${sr.id}:`, err.message);
      }
    }

    // Fall back to enhanced procedural generation
    console.info(`[disaster] using procedural generation for ${type}`);
    return this._generateProcedural(type);
  }

  /**
   * Build particle and light hints for a disaster type.
   * @param {string} type
   * @returns {{particles: Array, lights: Array}}
   */
  _buildDisasterExtras(type) {
    const particles = [];
    const lights = [];

    switch (type) {
      case 'whirlpool':
        particles.push({ type: 'spray', count: 200, speed: 3, color: 0x4488cc, lifetime: 2 });
        lights.push({ type: 'point', color: 0x2266aa, intensity: 0.5, distance: 20 });
        break;
      case 'tornado':
        particles.push({ type: 'debris', count: 300, speed: 8, color: 0x887766, lifetime: 3 });
        particles.push({ type: 'dust', count: 500, speed: 5, color: 0xaa9977, lifetime: 2 });
        lights.push({ type: 'ambient_shift', color: 0x666655, intensity: -0.3 });
        break;
      case 'typhoon':
        particles.push({ type: 'rain', count: 1000, speed: 15, color: 0x99aacc, lifetime: 1 });
        particles.push({ type: 'spray', count: 300, speed: 6, color: 0x88aadd, lifetime: 2 });
        lights.push({ type: 'flash', color: 0xffffff, intensity: 2, frequency: 0.1 });
        break;
      case 'dark_clouds':
        particles.push({ type: 'cloud_puff', count: 50, speed: 0.5, color: 0x444444, lifetime: 10 });
        lights.push({ type: 'ambient_shift', color: 0x444433, intensity: -0.5 });
        break;
      case 'rain_clouds':
        particles.push({ type: 'rain', count: 800, speed: 12, color: 0x99aacc, lifetime: 1.5 });
        particles.push({ type: 'cloud_puff', count: 30, speed: 0.3, color: 0x666666, lifetime: 12 });
        lights.push({ type: 'ambient_shift', color: 0x888888, intensity: -0.2 });
        break;
    }

    return { particles, lights };
  }

  /**
   * Generate an enhanced procedural disaster visual.
   * @param {string} type
   * @returns {{model: THREE.Group, particles: Array, lights: Array}}
   */
  _generateProcedural(type) {
    const group = new THREE.Group();
    group.name = `disaster_${type}`;
    const extras = this._buildDisasterExtras(type);

    switch (type) {
      case 'whirlpool':
        this._buildWhirlpool(group);
        break;
      case 'tornado':
        this._buildTornado(group);
        break;
      case 'typhoon':
        this._buildTyphoon(group);
        break;
      case 'dark_clouds':
      case 'rain_clouds':
        this._buildCloudBank(group, type === 'dark_clouds' ? 0x333333 : 0x666677);
        break;
    }

    return { model: group, ...extras };
  }

  _buildWhirlpool(group) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x1a5276,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
      roughness: 0.2,
    });

    // Layered rotating rings that form a funnel
    for (let i = 0; i < 8; i++) {
      const radius = 5 - i * 0.5;
      const y = -i * 0.4;
      const geo = new THREE.TorusGeometry(radius, 0.2 + i * 0.05, 8, 32);
      const ring = new THREE.Mesh(geo, mat.clone());
      ring.material.opacity = 0.7 - i * 0.06;
      ring.position.y = y;
      ring.rotation.x = Math.PI / 2;
      ring.userData.animHint = { type: 'rotate_y', speed: 2 + i * 0.3 };
      group.add(ring);
    }

    // Central vortex cone
    const coneGeo = new THREE.ConeGeometry(1, 4, 16, 1, true);
    const coneMat = new THREE.MeshStandardMaterial({
      color: 0x0e3d54,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
    });
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.position.y = -2;
    cone.userData.animHint = { type: 'rotate_y', speed: 3 };
    group.add(cone);
  }

  _buildTornado(group) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x776655,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
    });

    // Stacked, expanding rings forming a funnel
    const segments = 12;
    for (let i = 0; i < segments; i++) {
      const t = i / segments;
      const radius = 0.5 + t * 4;
      const y = t * 15;
      const geo = new THREE.TorusGeometry(radius, 0.3 + t * 0.2, 6, 24);
      const ring = new THREE.Mesh(geo, mat.clone());
      ring.material.opacity = 0.6 - t * 0.3;
      ring.position.y = y;
      ring.rotation.x = Math.PI / 2;
      ring.userData.animHint = { type: 'rotate_y', speed: 4 - t * 2 };
      group.add(ring);
    }

    // Central column
    const colGeo = new THREE.CylinderGeometry(0.3, 2, 15, 12, 1, true);
    const colMat = new THREE.MeshStandardMaterial({
      color: 0x887766,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
    });
    const col = new THREE.Mesh(colGeo, colMat);
    col.position.y = 7.5;
    col.userData.animHint = { type: 'rotate_y', speed: 3 };
    group.add(col);
  }

  _buildTyphoon(group) {
    // Large swirling cloud disk
    const diskGeo = new THREE.CylinderGeometry(12, 10, 2, 32, 1, false);
    const diskMat = new THREE.MeshStandardMaterial({
      color: 0x445566,
      transparent: true,
      opacity: 0.6,
      roughness: 1,
    });
    const disk = new THREE.Mesh(diskGeo, diskMat);
    disk.position.y = 10;
    disk.userData.animHint = { type: 'rotate_y', speed: 0.5 };
    group.add(disk);

    // Spiral arms
    for (let arm = 0; arm < 3; arm++) {
      const armGroup = new THREE.Group();
      armGroup.rotation.y = (arm / 3) * Math.PI * 2;

      for (let i = 0; i < 6; i++) {
        const angle = i * 0.4;
        const r = 3 + i * 1.5;
        const cloudGeo = new THREE.SphereGeometry(1.5 - i * 0.1, 8, 6);
        const cloudMat = new THREE.MeshStandardMaterial({
          color: 0x556677,
          transparent: true,
          opacity: 0.5,
          roughness: 1,
        });
        const cloud = new THREE.Mesh(cloudGeo, cloudMat);
        cloud.position.set(Math.cos(angle) * r, 10, Math.sin(angle) * r);
        cloud.scale.y = 0.4;
        armGroup.add(cloud);
      }

      armGroup.userData.animHint = { type: 'rotate_y', speed: 0.5 };
      group.add(armGroup);
    }
  }

  _buildCloudBank(group, color) {
    const count = 15;
    for (let i = 0; i < count; i++) {
      const x = (Math.random() - 0.5) * 30;
      const z = (Math.random() - 0.5) * 30;
      const y = 12 + Math.random() * 3;
      const size = 2 + Math.random() * 3;

      const geo = new THREE.SphereGeometry(size, 8, 6);
      const mat = new THREE.MeshStandardMaterial({
        color,
        transparent: true,
        opacity: 0.6 + Math.random() * 0.2,
        roughness: 1,
      });
      const cloud = new THREE.Mesh(geo, mat);
      cloud.position.set(x, y, z);
      cloud.scale.set(1, 0.4, 1);
      cloud.userData.animHint = { type: 'drift', speed: 0.2 + Math.random() * 0.3 };
      group.add(cloud);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 12. WeatherVisualService
// ───────────────────────────────────────────────────────────────────────────

/** Weather presets: fog, ambient light color, rain intensity */
const WEATHER_PRESETS = {
  clear: {
    fogNear: 200,
    fogFar: 1000,
    fogColor: 0x87ceeb,
    ambientColor: 0xffeedd,
    ambientIntensity: 0.6,
    rainIntensity: 0,
    cloudOpacity: 0.2,
  },
  cloudy: {
    fogNear: 100,
    fogFar: 600,
    fogColor: 0xaabbcc,
    ambientColor: 0xcccccc,
    ambientIntensity: 0.4,
    rainIntensity: 0,
    cloudOpacity: 0.6,
  },
  rainy: {
    fogNear: 50,
    fogFar: 300,
    fogColor: 0x889999,
    ambientColor: 0x999999,
    ambientIntensity: 0.3,
    rainIntensity: 0.6,
    cloudOpacity: 0.8,
  },
  stormy: {
    fogNear: 20,
    fogFar: 150,
    fogColor: 0x556666,
    ambientColor: 0x666666,
    ambientIntensity: 0.2,
    rainIntensity: 1.0,
    cloudOpacity: 0.95,
  },
};

class WeatherVisualService {
  constructor() {
    /** @type {THREE.Scene|null} */
    this._scene = null;
    /** @type {THREE.AmbientLight|null} */
    this._ambientLight = null;
    /** @type {THREE.Points|null} */
    this._rainSystem = null;
    /** @type {THREE.Group|null} */
    this._cloudGroup = null;

    /** Current interpolated state */
    this._current = { ...WEATHER_PRESETS.clear };
    /** Target state we're transitioning toward */
    this._target = { ...WEATHER_PRESETS.clear };
    /** Transition speed (0-1 per second) */
    this._transitionSpeed = 0.3;

    this._rainVelocities = null;
  }

  /**
   * Initialize and apply weather to a scene.
   *
   * @param {THREE.Scene} scene
   * @param {string} weatherState — 'clear' | 'cloudy' | 'rainy' | 'stormy'
   */
  applyWeather(scene, weatherState) {
    this._scene = scene;
    const preset = WEATHER_PRESETS[weatherState] || WEATHER_PRESETS.clear;
    this._target = { ...preset };

    // Initialize fog
    if (!scene.fog) {
      scene.fog = new THREE.Fog(preset.fogColor, preset.fogNear, preset.fogFar);
    }

    // Find or create ambient light
    this._ambientLight = null;
    scene.traverse((node) => {
      if (node.isAmbientLight && !this._ambientLight) {
        this._ambientLight = node;
      }
    });
    if (!this._ambientLight) {
      this._ambientLight = new THREE.AmbientLight(preset.ambientColor, preset.ambientIntensity);
      scene.add(this._ambientLight);
    }

    // Create rain particle system
    this._createRainSystem(scene);

    // Create cloud system
    this._createCloudSystem(scene);

    // Snap current state to target (no transition for initial apply)
    this._current = { ...this._target };
    this._applyCurrentState();

    console.info(`[weather] applied '${weatherState}' to scene`);
  }

  /**
   * Update weather visuals each frame. Call from your render loop.
   *
   * @param {number} dt — delta time in seconds
   */
  updateWeather(dt) {
    if (!this._scene) return;

    // Smoothly interpolate toward target
    const t = Math.min(1, this._transitionSpeed * dt);
    this._current.fogNear += (this._target.fogNear - this._current.fogNear) * t;
    this._current.fogFar += (this._target.fogFar - this._current.fogFar) * t;
    this._current.ambientIntensity += (this._target.ambientIntensity - this._current.ambientIntensity) * t;
    this._current.rainIntensity += (this._target.rainIntensity - this._current.rainIntensity) * t;
    this._current.cloudOpacity += (this._target.cloudOpacity - this._current.cloudOpacity) * t;

    // Interpolate colors
    this._current.fogColor = this._lerpColor(this._current.fogColor, this._target.fogColor, t);
    this._current.ambientColor = this._lerpColor(this._current.ambientColor, this._target.ambientColor, t);

    this._applyCurrentState();
    this._updateRain(dt);
    this._updateClouds(dt);
  }

  /**
   * Transition to a new weather state (smooth).
   * @param {string} weatherState
   */
  setWeather(weatherState) {
    const preset = WEATHER_PRESETS[weatherState] || WEATHER_PRESETS.clear;
    this._target = { ...preset };
    console.info(`[weather] transitioning to '${weatherState}'`);
  }

  /* ── Internal ── */

  _applyCurrentState() {
    const scene = this._scene;
    if (!scene) return;

    // Fog
    if (scene.fog) {
      scene.fog.near = this._current.fogNear;
      scene.fog.far = this._current.fogFar;
      scene.fog.color.set(this._current.fogColor);
    }

    // Ambient light
    if (this._ambientLight) {
      this._ambientLight.color.set(this._current.ambientColor);
      this._ambientLight.intensity = this._current.ambientIntensity;
    }

    // Rain visibility
    if (this._rainSystem) {
      this._rainSystem.visible = this._current.rainIntensity > 0.01;
    }

    // Cloud opacity
    if (this._cloudGroup) {
      this._cloudGroup.traverse((node) => {
        if (node.isMesh && node.material) {
          node.material.opacity = this._current.cloudOpacity;
        }
      });
    }
  }

  _createRainSystem(scene) {
    const count = 5000;
    const positions = new Float32Array(count * 3);
    this._rainVelocities = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 100;
      positions[i * 3 + 1] = Math.random() * 50;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 100;
      this._rainVelocities[i] = 10 + Math.random() * 10;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.PointsMaterial({
      color: 0xaabbdd,
      size: 0.1,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    });

    this._rainSystem = new THREE.Points(geo, mat);
    this._rainSystem.visible = false;
    this._rainSystem.name = 'weather_rain';
    scene.add(this._rainSystem);
  }

  _updateRain(dt) {
    if (!this._rainSystem || !this._rainSystem.visible) return;

    const positions = this._rainSystem.geometry.attributes.position.array;
    const velocities = this._rainVelocities;
    const intensity = this._current.rainIntensity;

    for (let i = 0; i < velocities.length; i++) {
      positions[i * 3 + 1] -= velocities[i] * intensity * dt;
      if (positions[i * 3 + 1] < 0) {
        positions[i * 3 + 1] = 50;
        positions[i * 3] = (Math.random() - 0.5) * 100;
        positions[i * 3 + 2] = (Math.random() - 0.5) * 100;
      }
    }
    this._rainSystem.geometry.attributes.position.needsUpdate = true;
    this._rainSystem.material.opacity = 0.3 + intensity * 0.4;
  }

  _createCloudSystem(scene) {
    this._cloudGroup = new THREE.Group();
    this._cloudGroup.name = 'weather_clouds';

    const cloudMat = new THREE.MeshStandardMaterial({
      color: 0x999999,
      transparent: true,
      opacity: 0.3,
      roughness: 1,
      depthWrite: false,
    });

    for (let i = 0; i < 20; i++) {
      const size = 5 + Math.random() * 10;
      const geo = new THREE.SphereGeometry(size, 8, 6);
      const cloud = new THREE.Mesh(geo, cloudMat.clone());
      cloud.position.set(
        (Math.random() - 0.5) * 150,
        30 + Math.random() * 10,
        (Math.random() - 0.5) * 150
      );
      cloud.scale.set(1, 0.3, 1);
      cloud.userData.driftSpeed = 0.5 + Math.random() * 1;
      this._cloudGroup.add(cloud);
    }

    scene.add(this._cloudGroup);
  }

  _updateClouds(dt) {
    if (!this._cloudGroup) return;
    for (const cloud of this._cloudGroup.children) {
      cloud.position.x += (cloud.userData.driftSpeed || 0.5) * dt;
      if (cloud.position.x > 80) cloud.position.x = -80;
    }
  }

  /**
   * Linearly interpolate between two hex colors.
   * @param {number} a
   * @param {number} b
   * @param {number} t — 0 to 1
   * @returns {number}
   */
  _lerpColor(a, b, t) {
    const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
    const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
    const rr = Math.round(ar + (br - ar) * t);
    const rg = Math.round(ag + (bg - ag) * t);
    const rb = Math.round(ab + (bb - ab) * t);
    return (rr << 16) | (rg << 8) | rb;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Singleton Instances & Wiring
// ───────────────────────────────────────────────────────────────────────────

const assetCache = new AssetCache();
const assetMetadataRegistry = new AssetMetadataRegistry();
const assetScoringService = new AssetScoringService();
const assetSearchService = new AssetSearchService(assetCache, assetScoringService);
const assetDownloadService = new AssetDownloadService(assetCache);
const textureImportService = new TextureImportService(assetDownloadService);
const modelImportService = new ModelImportService(assetDownloadService, assetScoringService);
const characterImportService = new CharacterImportService(modelImportService);
const npcPopulationService = new NPCPopulationService(characterImportService, assetSearchService);
const inventoryModelService = new InventoryModelService(assetSearchService, modelImportService);
const disasterAssetService = new DisasterAssetService(assetSearchService, modelImportService);
const weatherVisualService = new WeatherVisualService();

// ───────────────────────────────────────────────────────────────────────────
// Named Exports
// ───────────────────────────────────────────────────────────────────────────

// Expose on global namespace
window.AssetPipeline = {
  AssetCache,
  AssetMetadataRegistry,
  AssetScoringService,
  AssetSearchService,
  AssetDownloadService,
  TextureImportService,
  ModelImportService,
  CharacterImportService,
  NPCPopulationService,
  InventoryModelService,
  DisasterAssetService,
  WeatherVisualService,
};

})(); // end IIFE
