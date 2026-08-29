import { marketplacePool } from '../server/marketplace/postgres.ts';
import { createMarketplaceHealthApi } from '../server/operations/healthApi.ts';

const api = createMarketplaceHealthApi({
  async probe() {
    if (!marketplacePool) throw new Error('Marketplace database is not configured');
    await marketplacePool.query('SELECT 1');
  },
});

export default {
  fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    url.pathname = '/api/marketplace/health';
    url.search = '';
    return api.fetch(new Request(url, request));
  },
};
