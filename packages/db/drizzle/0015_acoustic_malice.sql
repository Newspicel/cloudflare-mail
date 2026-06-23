ALTER TABLE `draft` ADD `format` text DEFAULT 'text' NOT NULL;
--> statement-breakpoint
UPDATE `draft` SET `format` = 'markdown' WHERE `markdown` = 1;