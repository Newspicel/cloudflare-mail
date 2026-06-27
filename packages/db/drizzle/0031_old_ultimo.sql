DROP INDEX `rule_mailbox_priority_idx`;--> statement-breakpoint
CREATE INDEX `rule_mailbox_priority_idx` ON `rule` (`mailbox_id`,`enabled`,`priority`,`created_at`);--> statement-breakpoint
DROP INDEX `thread_mailbox_subject_idx`;--> statement-breakpoint
DROP INDEX `thread_trashed_at_idx`;--> statement-breakpoint
CREATE INDEX `thread_mailbox_subject_idx` ON `thread` (`mailbox_id`,`subject_norm`,`last_msg_at`);--> statement-breakpoint
CREATE INDEX `thread_trashed_at_idx` ON `thread` (`trashed`,`trashed_at`);