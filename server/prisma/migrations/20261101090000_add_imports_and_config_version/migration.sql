/**
 * B3：门店配置版本、品类与受控导入记录。
 *
 * 说明：
 * - stores.category 与 stores.config_version 支持门店资料版本化。
 * - store_imports 保存 apply 幂等键与首次结果快照。
 * - 不在 store_tables 上加唯一约束（历史数据风险），桌号唯一性由应用层校验。
 */
ALTER TABLE `stores`
  ADD COLUMN `category` VARCHAR(48) NOT NULL DEFAULT '' AFTER `name`,
  ADD COLUMN `config_version` INT NOT NULL DEFAULT 0 AFTER `catalog_version`;

CREATE TABLE `store_imports` (
  `id` CHAR(26) NOT NULL,
  `store_id` VARCHAR(64) NOT NULL,
  `user_id` CHAR(26) NOT NULL,
  `idempotency_key` VARCHAR(128) NOT NULL,
  `request_hash` CHAR(64) NOT NULL,
  `source_draft_digest` CHAR(64) NOT NULL,
  `status` VARCHAR(16) NOT NULL,
  `preview_token` CHAR(64) NOT NULL,
  `result_json` JSON NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `store_imports_store_id_user_id_idempotency_key_key` (`store_id`, `user_id`, `idempotency_key`),
  KEY `store_imports_store_id_created_at_idx` (`store_id`, `created_at`),
  CONSTRAINT `store_imports_store_id_fkey` FOREIGN KEY (`store_id`) REFERENCES `stores` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `store_imports_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;