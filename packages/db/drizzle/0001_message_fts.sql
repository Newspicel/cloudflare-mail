CREATE VIRTUAL TABLE `message_fts` USING fts5(
  subject,
  snippet,
  from_text,
  message_id UNINDEXED,
  mailbox_id UNINDEXED,
  tokenize = 'porter unicode61 remove_diacritics 2'
);--> statement-breakpoint
CREATE TRIGGER `message_fts_ai` AFTER INSERT ON `message` BEGIN
  INSERT INTO `message_fts` (subject, snippet, from_text, message_id, mailbox_id)
  VALUES (new.subject, new.snippet, coalesce(new.from_name, '') || ' ' || new.from_addr, new.id, new.mailbox_id);
END;--> statement-breakpoint
CREATE TRIGGER `message_fts_ad` AFTER DELETE ON `message` BEGIN
  DELETE FROM `message_fts` WHERE message_id = old.id;
END;--> statement-breakpoint
CREATE TRIGGER `message_fts_au` AFTER UPDATE OF subject, snippet, from_name, from_addr ON `message` BEGIN
  DELETE FROM `message_fts` WHERE message_id = old.id;
  INSERT INTO `message_fts` (subject, snippet, from_text, message_id, mailbox_id)
  VALUES (new.subject, new.snippet, coalesce(new.from_name, '') || ' ' || new.from_addr, new.id, new.mailbox_id);
END;
