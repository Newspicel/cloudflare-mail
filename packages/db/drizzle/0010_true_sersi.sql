ALTER TABLE `mailbox` ADD `service_key_hash` text;--> statement-breakpoint
ALTER TABLE `mailbox` ADD `service_mode` text DEFAULT 'duplex' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `mailbox_service_key_idx` ON `mailbox` (`service_key_hash`);--> statement-breakpoint
-- Pre-existing service mailboxes were send-only (rejected inbound); keep that
-- behavior rather than silently flipping them to duplex on upgrade.
UPDATE `mailbox` SET `service_mode` = 'send' WHERE `type` = 'service';