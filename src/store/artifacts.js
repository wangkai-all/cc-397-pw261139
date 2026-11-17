import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, nowIso, sha256 } from '../lib/util.js';

/**
 * Cache artifacts live under:
 *   <root>/artifacts/<specId>/v<configVersion>/<configHash>/<generation>/data.json
 *   <root>/artifacts/<specId>/v<configVersion>/<configHash>/<generation>/meta.json
 *   <root>/artifacts/<specId>/v<configVersion>/<configHash>/current.json
 *
 * `current.json` is the publish pointer. A builder writes a complete generation
 * to a temp dir, fsyncs, then atomically renames and finally flips `current.json`.
 * Readers only trust a generation whose manifest matches the bytes they read.
 */
export class ArtifactStore {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  }

  versionDir(specId, configVersion, configHash) {
    return path.join(
      this.root,
      'artifacts',
      specId,
      `v${configVersion}`,
      configHash,
    );
  }

  generationDir(specId, configVersion, configHash, generation) {
    return path.join(
      this.versionDir(specId, configVersion, configHash),
      `g${generation}`,
    );
  }

  currentPointerPath(specId, configVersion, configHash) {
    return path.join(this.versionDir(specId, configVersion, configHash), 'current.json');
  }

  readCurrentPointer(specId, configVersion, configHash) {
    const file = this.currentPointerPath(specId, configVersion, configHash);
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Atomically publishes a fully-built generation. Returns the manifest.
   */
  publish({ specId, configVersion, configHash, generation, build, data }) {
    const generationDir = this.generationDir(specId, configVersion, configHash, generation);
    fs.mkdirSync(generationDir, { recursive: true });

    const dataBytes = Buffer.from(data);
    const dataHash = sha256(dataBytes);
    const dataName = `data-${dataHash.slice(0, 16)}.json`;
    const dataPath = path.join(generationDir, dataName);
    writeFileDurable(dataPath, dataBytes);

    const manifest = {
      kind: 'artifact-manifest-v1',
      specId,
      configVersion,
      configHash,
      generation,
      build,
      dataFile: dataName,
      dataHash,
      dataBytes: dataBytes.length,
      createdAt: nowIso(),
    };
    const manifestBytes = Buffer.from(canonicalJson(manifest) + '\n');
    writeFileDurable(path.join(generationDir, 'manifest.json'), manifestBytes);

    const pointer = {
      kind: 'artifact-pointer-v1',
      specId,
      configVersion,
      configHash,
      generation,
      snapshotSeq: build?.snapshotSeq ?? null,
      builtSeq: build?.builtSeq ?? null,
      manifestHash: sha256(manifestBytes),
      dataHash,
      publishedAt: nowIso(),
    };
    const tmpPointer = path.join(
      this.versionDir(specId, configVersion, configHash),
      `.current-${generation}.json.tmp`,
    );
    writeFileDurable(tmpPointer, Buffer.from(JSON.stringify(pointer, null, 2)));
    fs.renameSync(tmpPointer, this.currentPointerPath(specId, configVersion, configHash));
    return pointer;
  }

  /**
   * Reads and verifies a published generation. Returns null when absent or
   * inconsistent — a corrupt artifact must never be served as authoritative.
   */
  readVerified(specId, configVersion, configHash) {
    const pointer = this.readCurrentPointer(specId, configVersion, configHash);
    if (!pointer) return null;
    if (pointer.specId !== specId) return null;
    if (Number(pointer.configVersion) !== Number(configVersion)) return null;
    if (pointer.configHash !== configHash) return null;
    const generationDir = this.generationDir(
      specId,
      configVersion,
      configHash,
      pointer.generation,
    );
    let manifestBytes;
    let dataBytes;
    try {
      manifestBytes = fs.readFileSync(path.join(generationDir, 'manifest.json'));
      const manifest = JSON.parse(manifestBytes.toString('utf8'));
      if (sha256(manifestBytes) !== pointer.manifestHash) return null;
      if (manifest.dataHash !== pointer.dataHash) return null;
      dataBytes = fs.readFileSync(path.join(generationDir, manifest.dataFile));
      if (sha256(dataBytes) !== manifest.dataHash) return null;
      if (dataBytes.length !== manifest.dataBytes) return null;
      const data = JSON.parse(dataBytes.toString('utf8'));
      if (data?.proof?.outputDigest !== manifest.build?.outputDigest) return null;
      if (data?.proof?.generation !== manifest.generation) return null;
      return {
        pointer,
        manifest,
        data,
        dataHash: manifest.dataHash,
        bytes: dataBytes.length,
      };
    } catch {
      return null;
    }
  }

  generationDataPath(specId, configVersion, configHash, generation, dataFile) {
    return path.join(
      this.generationDir(specId, configVersion, configHash, generation),
      dataFile,
    );
  }

  readGenerationData(specId, configVersion, configHash, generation, dataFile) {
    return fs.readFileSync(
      this.generationDataPath(specId, configVersion, configHash, generation, dataFile),
    );
  }

  listGenerations(specId, configVersion, configHash) {
    const dir = this.versionDir(specId, configVersion, configHash);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  }

  removeGeneration(specId, configVersion, configHash, generation) {
    const dir = this.generationDir(specId, configVersion, configHash, generation);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  readGenerationManifest(specId, configVersion, configHash, generation) {
    try {
      const raw = fs.readFileSync(
        path.join(
          this.generationDir(specId, configVersion, configHash, generation),
          'manifest.json',
        ),
        'utf8',
      );
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Serves a byte range of the currently published data file. Used by the
   * download cache so the client can prove which generation it downloaded.
   */
  openCurrentData(specId, configVersion, configHash) {
    const pointer = this.readCurrentPointer(specId, configVersion, configHash);
    if (!pointer) return null;
    const generationDir = this.generationDir(
      specId,
      configVersion,
      configHash,
      pointer.generation,
    );
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(generationDir, 'manifest.json'), 'utf8'),
      );
      const file = path.join(generationDir, manifest.dataFile);
      const stat = fs.statSync(file);
      return { pointer, manifest, file, size: stat.size };
    } catch {
      return null;
    }
  }
}

function writeFileDurable(file, bytes) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Directory fsync is best-effort across platforms.
  }
}
