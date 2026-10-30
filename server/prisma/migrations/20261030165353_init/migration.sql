-- CreateTable
CREATE TABLE `users` (
    `id` CHAR(26) NOT NULL,
    `open_id` VARCHAR(64) NOT NULL,
    `display_name` VARCHAR(64) NOT NULL DEFAULT '微信顾客',
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `users_open_id_key`(`open_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sessions` (
    `id` CHAR(26) NOT NULL,
    `user_id` CHAR(26) NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `sessions_token_hash_key`(`token_hash`),
    INDEX `sessions_user_id_idx`(`user_id`),
    INDEX `sessions_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stores` (
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `address` VARCHAR(255) NOT NULL DEFAULT '',
    `phone` VARCHAR(32) NOT NULL DEFAULT '',
    `business_hours` VARCHAR(64) NOT NULL DEFAULT '',
    `dine_in_enabled` BOOLEAN NOT NULL DEFAULT true,
    `takeaway_enabled` BOOLEAN NOT NULL DEFAULT true,
    `background_color` CHAR(7) NOT NULL DEFAULT '#F7F3EC',
    `text_color` CHAR(7) NOT NULL DEFAULT '#232323',
    `primary_color` CHAR(7) NOT NULL DEFAULT '#E86A17',
    `catalog_version` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `store_members` (
    `id` CHAR(26) NOT NULL,
    `store_id` VARCHAR(64) NOT NULL,
    `user_id` CHAR(26) NOT NULL,
    `role` ENUM('OWNER', 'STAFF') NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    INDEX `store_members_user_id_idx`(`user_id`),
    UNIQUE INDEX `store_members_store_id_user_id_key`(`store_id`, `user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `categories` (
    `id` VARCHAR(64) NOT NULL,
    `store_id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL,

    INDEX `categories_store_id_sort_order_idx`(`store_id`, `sort_order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `products` (
    `id` VARCHAR(64) NOT NULL,
    `store_id` VARCHAR(64) NOT NULL,
    `category_id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `description` VARCHAR(255) NOT NULL DEFAULT '',
    `price_cents` INTEGER UNSIGNED NOT NULL,
    `image_url` VARCHAR(512) NOT NULL DEFAULT '',
    `available` BOOLEAN NOT NULL DEFAULT true,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `products_store_id_category_id_sort_order_idx`(`store_id`, `category_id`, `sort_order`),
    INDEX `products_store_id_available_idx`(`store_id`, `available`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `store_tables` (
    `id` VARCHAR(64) NOT NULL,
    `store_id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(32) NOT NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL,

    INDEX `store_tables_store_id_sort_order_idx`(`store_id`, `sort_order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `orders` (
    `id` CHAR(26) NOT NULL,
    `store_id` VARCHAR(64) NOT NULL,
    `user_id` CHAR(26) NOT NULL,
    `table_id` VARCHAR(64) NULL,
    `fulfillment_type` ENUM('DINE_IN', 'TAKEAWAY') NOT NULL,
    `status` ENUM('PENDING_PAYMENT', 'PENDING_ACCEPT', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED') NOT NULL,
    `payment_status` ENUM('UNPAID', 'DEMO_PAID') NOT NULL,
    `total_cents` INTEGER UNSIGNED NOT NULL,
    `note` VARCHAR(255) NOT NULL DEFAULT '',
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `orders_store_id_status_created_at_idx`(`store_id`, `status`, `created_at`),
    INDEX `orders_user_id_store_id_created_at_idx`(`user_id`, `store_id`, `created_at`),
    INDEX `orders_store_id_created_at_idx`(`store_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_items` (
    `id` CHAR(26) NOT NULL,
    `order_id` CHAR(26) NOT NULL,
    `product_id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `unit_price_cents` INTEGER UNSIGNED NOT NULL,
    `quantity` INTEGER UNSIGNED NOT NULL,
    `line_total_cents` INTEGER UNSIGNED NOT NULL,

    INDEX `order_items_order_id_idx`(`order_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_status_logs` (
    `id` CHAR(26) NOT NULL,
    `order_id` CHAR(26) NOT NULL,
    `from_status` ENUM('PENDING_PAYMENT', 'PENDING_ACCEPT', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED') NULL,
    `to_status` ENUM('PENDING_PAYMENT', 'PENDING_ACCEPT', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED') NOT NULL,
    `actor_type` ENUM('CUSTOMER', 'MERCHANT', 'SYSTEM') NOT NULL,
    `actor_id` CHAR(26) NULL,
    `reason` VARCHAR(255) NULL,
    `created_at` DATETIME(3) NOT NULL,

    INDEX `order_status_logs_order_id_created_at_idx`(`order_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `idempotency_keys` (
    `id` CHAR(26) NOT NULL,
    `user_id` CHAR(26) NOT NULL,
    `store_id` VARCHAR(64) NOT NULL,
    `key` VARCHAR(128) NOT NULL,
    `request_hash` CHAR(64) NOT NULL,
    `order_id` CHAR(26) NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    INDEX `idempotency_keys_expires_at_idx`(`expires_at`),
    UNIQUE INDEX `idempotency_keys_user_id_store_id_key_key`(`user_id`, `store_id`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `store_members` ADD CONSTRAINT `store_members_store_id_fkey` FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `store_members` ADD CONSTRAINT `store_members_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `categories` ADD CONSTRAINT `categories_store_id_fkey` FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `products` ADD CONSTRAINT `products_store_id_fkey` FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `products` ADD CONSTRAINT `products_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `store_tables` ADD CONSTRAINT `store_tables_store_id_fkey` FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `orders` ADD CONSTRAINT `orders_store_id_fkey` FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `orders` ADD CONSTRAINT `orders_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `orders` ADD CONSTRAINT `orders_table_id_fkey` FOREIGN KEY (`table_id`) REFERENCES `store_tables`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order_status_logs` ADD CONSTRAINT `order_status_logs_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `idempotency_keys` ADD CONSTRAINT `idempotency_keys_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `idempotency_keys` ADD CONSTRAINT `idempotency_keys_store_id_fkey` FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
