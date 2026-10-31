import { Controller, Get, Param } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service';
import type { PublicCatalogView } from '../catalog/catalog.service';
import { StoresService } from './stores.service';
import type { PublicStoreView, PublicTablesView } from './stores.service';

@Controller('stores')
export class StoresController {
  constructor(
    private readonly storesService: StoresService,
    private readonly catalogService: CatalogService,
  ) {}

  @Get(':storeId')
  getStore(@Param('storeId') storeId: string): Promise<PublicStoreView> {
    return this.storesService.getPublicStore(storeId);
  }

  @Get(':storeId/catalog')
  getCatalog(@Param('storeId') storeId: string): Promise<PublicCatalogView> {
    return this.catalogService.getPublicCatalog(storeId);
  }

  @Get(':storeId/tables')
  getTables(@Param('storeId') storeId: string): Promise<PublicTablesView> {
    return this.storesService.listTables(storeId);
  }
}