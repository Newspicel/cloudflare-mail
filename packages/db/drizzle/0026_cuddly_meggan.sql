CREATE TABLE `thread_summary` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`bullets` text NOT NULL,
	`msg_count` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade
);
