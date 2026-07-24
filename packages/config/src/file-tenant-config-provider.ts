import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ITenantConfigProvider, TenantConfig } from '@platform/core';
import { tenantConfigSchema } from './schema.js';

/**
 * Loads tenant configuration from a directory of JSON files (one file per
 * tenant, e.g. `tenants/acme-dental.json`). Each file is validated against
 * `tenantConfigSchema` at load time, so misconfigured tenants fail fast at
 * startup rather than mid-call.
 *
 * This is the default `ITenantConfigProvider` implementation, suitable for
 * local development and single-/few-tenant deployments. A future
 * Postgres-backed or remote Tenant/Config-service implementation can
 * satisfy the same interface without any change to calling code - that's
 * the whole point of depending on the interface rather than this class.
 */
export class FileTenantConfigProvider implements ITenantConfigProvider {
  private readonly byTenantId = new Map<string, TenantConfig>();
  private readonly byPhoneNumber = new Map<string, string>();
  private loaded: Promise<void> | null = null;

  constructor(private readonly directory: string) {}

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      this.loaded = this.load();
    }
    return this.loaded;
  }

  private async load(): Promise<void> {
    const entries = await readdir(this.directory);
    const jsonFiles = entries.filter((f) => f.endsWith('.json'));

    if (jsonFiles.length === 0) {
      throw new Error(`No tenant config files (*.json) found in ${this.directory}`);
    }

    for (const file of jsonFiles) {
      const fullPath = path.join(this.directory, file);
      const raw = await readFile(fullPath, 'utf-8');

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new Error(`Failed to parse tenant config ${fullPath}: ${(err as Error).message}`);
      }

      const result = tenantConfigSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(`Invalid tenant config ${fullPath}: ${result.error.message}`);
      }

      const config = result.data as TenantConfig;

      if (this.byTenantId.has(config.tenantId)) {
        throw new Error(`Duplicate tenantId "${config.tenantId}" in ${fullPath}`);
      }
      this.byTenantId.set(config.tenantId, config);

      for (const number of config.inboundPhoneNumbers) {
        if (this.byPhoneNumber.has(number)) {
          throw new Error(
            `Phone number ${number} is configured for both ${this.byPhoneNumber.get(number)} and ${config.tenantId}`,
          );
        }
        this.byPhoneNumber.set(number, config.tenantId);
      }
    }
  }

  async resolveTenantByPhoneNumber(phoneNumber: string): Promise<TenantConfig | null> {
    await this.ensureLoaded();
    const tenantId = this.byPhoneNumber.get(phoneNumber);
    if (!tenantId) return null;
    return this.byTenantId.get(tenantId) ?? null;
  }

  async getTenantConfig(tenantId: string): Promise<TenantConfig> {
    await this.ensureLoaded();
    const config = this.byTenantId.get(tenantId);
    if (!config) {
      throw new Error(`Unknown tenantId "${tenantId}"`);
    }
    return config;
  }

  /** Returns all loaded tenant IDs. Useful for admin/debug endpoints and tests. */
  async listTenantIds(): Promise<string[]> {
    await this.ensureLoaded();
    return [...this.byTenantId.keys()];
  }
}
