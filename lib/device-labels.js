import * as filesystem from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// Storage carries JSON text; null means the file is genuinely missing.
export function createFileDeviceLabelStorage(path, { fs = filesystem } = {}) {
  return {
    async read() {
      try {
        return await fs.readFile(path, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async write(contents) {
      await fs.mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, contents, "utf8");
        await fs.rename(temporary, path);
      } catch (error) {
        await fs.unlink(temporary).catch(() => {});
        throw error;
      }
    },
  };
}

export function createMemoryDeviceLabelStorage(initial = null) {
  let contents = initial;
  return {
    async read() { return contents; },
    async write(value) { contents = value; },
  };
}

function parseConfiguration(contents) {
  if (contents === null) return { devices: {} };
  let config;
  try {
    config = JSON.parse(contents);
  } catch (cause) {
    throw new Error("Device configuration is not valid JSON.", { cause });
  }
  return validateConfiguration(config);
}

function validateConfiguration(config) {
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!object(config) || !object(config.devices)
      || Object.values(config.devices).some((name) => typeof name !== "string")) {
    throw new Error("Device configuration must contain a devices object with string labels.");
  }
  return config;
}

export function createDeviceLabels(storage) {
  let tail = Promise.resolve();
  const enqueue = (operation) => {
    const result = tail.then(operation);
    // Keep each failure with its caller without blocking later operations.
    tail = result.catch(() => {});
    return result;
  };
  const read = async () => parseConfiguration(await storage.read());
  const mutate = (change) => enqueue(async () => {
    const config = await read();
    const devices = change(config.devices);
    if (devices === null) return;
    config.devices = Object.fromEntries(Object.entries(devices).sort(([a], [b]) => a.localeCompare(b)));
    validateConfiguration(config);
    await storage.write(`${JSON.stringify(config, null, 2)}\n`);
  });
  return {
    read: () => enqueue(read),
    setManual: (keys, name) => mutate((devices) => {
      const addresses = new Set(keys.map((key) => key.toLowerCase()));
      const entries = new Map(Object.entries(devices).filter(([key]) => !addresses.has(key.toLowerCase())));
      if (name) for (const key of addresses) entries.set(key, name);
      return Object.fromEntries(entries);
    }),
    learnAlias: (key, name) => mutate((devices) => {
      const address = key.toLowerCase();
      if (!name || Object.keys(devices).some((existing) => existing.toLowerCase() === address)) return null;
      return Object.fromEntries([...Object.entries(devices), [address, name]]);
    }),
  };
}
