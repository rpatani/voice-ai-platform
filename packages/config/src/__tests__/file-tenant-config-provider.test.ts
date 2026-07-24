import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FileTenantConfigProvider } from '../file-tenant-config-provider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tenantsDir = path.resolve(__dirname, '../../tenants');

describe('FileTenantConfigProvider', () => {
  it('loads and validates the sample tenant config', async () => {
    const provider = new FileTenantConfigProvider(tenantsDir);
    const ids = await provider.listTenantIds();
    expect(ids).toContain('demo-dental');
  });

  it('resolves a tenant by inbound phone number', async () => {
    const provider = new FileTenantConfigProvider(tenantsDir);
    const config = await provider.resolveTenantByPhoneNumber('+15551234567');
    expect(config?.tenantId).toBe('demo-dental');
    expect(config?.providers.llm).toBe('openai');
    expect(config?.services.map((s) => s.id)).toEqual(['cleaning', 'checkup']);
  });

  it('returns null for an unknown phone number', async () => {
    const provider = new FileTenantConfigProvider(tenantsDir);
    const config = await provider.resolveTenantByPhoneNumber('+10000000000');
    expect(config).toBeNull();
  });

  it('throws for an unknown tenant id', async () => {
    const provider = new FileTenantConfigProvider(tenantsDir);
    await expect(provider.getTenantConfig('does-not-exist')).rejects.toThrow(/Unknown tenantId/);
  });
});
