import { marketplacePool } from '../server/marketplace/postgres.ts';
import {
  createMarketplaceHealthApi,
  probeMarketplaceStorage,
} from '../server/operations/healthApi.ts';

const api = createMarketplaceHealthApi({
  async probe() {
    if (!marketplacePool) throw new Error('Marketplace database is not configured');
    await probeMarketplaceStorage(marketplacePool);
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
