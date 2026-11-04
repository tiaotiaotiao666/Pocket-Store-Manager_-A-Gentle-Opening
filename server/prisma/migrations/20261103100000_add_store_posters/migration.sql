CREATE TABLE `store_posters` (
  `id` VARCHAR(64) NOT NULL,
  `store_id` VARCHAR(64) NOT NULL,
  `product_id` VARCHAR(64) NOT NULL,
  `title` VARCHAR(48) NOT NULL,
  `subtitle` VARCHAR(96) NOT NULL DEFAULT '',
  `image_url` VARCHAR(512) NOT NULL DEFAULT '',
  `active` BOOLEAN NOT NULL DEFAULT true,
  `sort_order` INTEGER NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  INDEX `store_posters_store_id_active_sort_order_idx` (`store_id`, `active`, `sort_order`),
  PRIMARY KEY (`id`),
  CONSTRAINT `store_posters_store_id_fkey` FOREIGN KEY (`store_id`) REFERENCES `stores` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `store_posters_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
