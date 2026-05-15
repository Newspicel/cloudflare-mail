-- System config (lazy-init auth secret, transactional from-address).
CREATE TABLE `system_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint

-- Better Auth admin plugin fields on user/session.
ALTER TABLE `user` ADD `role` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `banned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `ban_reason` text;--> statement-breakpoint
ALTER TABLE `user` ADD `ban_expires` integer;--> statement-breakpoint
-- Better Auth twoFactor plugin field on user.
ALTER TABLE `user` ADD `two_factor_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `impersonated_by` text;--> statement-breakpoint

-- twoFactor plugin table.
CREATE TABLE `two_factor` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`secret` text NOT NULL,
	`backup_codes` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `two_factor_user_idx` ON `two_factor` (`user_id`);--> statement-breakpoint

-- App-level user invites (admin-controlled signup).
CREATE TABLE `user_invite` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`token` text NOT NULL,
	`invited_by_user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`invited_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_invite_token_uq` ON `user_invite` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_invite_email_uq` ON `user_invite` (`email`);--> statement-breakpoint
CREATE INDEX `user_invite_expires_idx` ON `user_invite` (`expires_at`);--> statement-breakpoint

-- domain: drop legacy is_temp_domain, add allowed_kinds bitfield.
ALTER TABLE `domain` DROP COLUMN `is_temp_domain`;--> statement-breakpoint
ALTER TABLE `domain` ADD `allowed_kinds` integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- Per-user permission to create mailboxes of given kinds on a given domain.
CREATE TABLE `domain_grant` (
	`domain_id` text NOT NULL,
	`user_id` text NOT NULL,
	`allowed_kinds` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`domain_id`, `user_id`),
	FOREIGN KEY (`domain_id`) REFERENCES `domain`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `domain_grant_user_idx` ON `domain_grant` (`user_id`);
