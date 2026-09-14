CREATE TABLE `bimi_logo` (
	`domain` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`svg` text,
	`source` text,
	`has_authority` integer DEFAULT false NOT NULL,
	`fetched_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bimi_logo_expires_idx` ON `bimi_logo` (`expires_at`);