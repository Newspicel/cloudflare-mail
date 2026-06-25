ALTER TABLE `mailbox` ADD `pending_purge` text;--> statement-breakpoint
CREATE INDEX `mailbox_pending_purge_idx` ON `mailbox` (`pending_purge`);