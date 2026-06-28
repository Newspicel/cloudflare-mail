ALTER TABLE `mailbox_notify` ADD `high` text DEFAULT 'important' NOT NULL;--> statement-breakpoint
ALTER TABLE `mailbox_notify` ADD `normal` text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE `mailbox_notify` ADD `low` text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE `message` ADD `ai_priority` text;--> statement-breakpoint
ALTER TABLE `thread` ADD `ai_priority` text;