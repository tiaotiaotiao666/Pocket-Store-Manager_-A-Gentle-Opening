import { Module } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service';
import { StoresController } from './stores.controller';
import { StoresService } from './stores.service';

@Module({
  controllers: [StoresController],
  providers: [StoresService, CatalogService],
  exports: [StoresService, CatalogService],
})
export class StoresModule {}