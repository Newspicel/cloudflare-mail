-- Rebuild the message FTS index to also cover the full plaintext body and the
-- recipient text. Hand-written (FTS5 + triggers can't be expressed by
-- drizzle-kit, same as 0001). body_text/to_text were added in 0012.
DROP TRIGGER IF EXISTS `message_fts_ai`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `message_fts_ad`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `message_fts_au`;--> statement-breakpoint
DROP TABLE IF EXISTS `message_fts`;--> statement-breakpoint
CREATE VIRTUAL TABLE `message_fts` USING fts5(
  subject,
  snippet,
  body,
  from_text,
  to_text,
  message_id UNINDEXED,
  mailbox_id UNINDEXED,
  tokenize = 'porter unicode61 remove_diacritics 2'
);--> statement-breakpoint
CREATE TRIGGER `message_fts_ai` AFTER INSERT ON `message` BEGIN
  INSERT INTO `message_fts` (subject, snippet, body, from_text, to_text, message_id, mailbox_id)
  VALUES (new.subject, new.snippet, coalesce(new.body_text, ''), coalesce(new.from_name, '') || ' ' || new.from_addr, coalesce(new.to_text, ''), new.id, new.mailbox_id);
END;--> statement-breakpoint
CREATE TRIGGER `message_fts_ad` AFTER DELETE ON `message` BEGIN
  DELETE FROM `message_fts` WHERE message_id = old.id;
END;--> statement-breakpoint
CREATE TRIGGER `message_fts_au` AFTER UPDATE OF subject, snippet, from_name, from_addr ON `message` BEGIN
  DELETE FROM `message_fts` WHERE message_id = old.id;
  INSERT INTO `message_fts` (subject, snippet, body, from_text, to_text, message_id, mailbox_id)
  VALUES (new.subject, new.snippet, coalesce(new.body_text, ''), coalesce(new.from_name, '') || ' ' || new.from_addr, coalesce(new.to_text, ''), new.id, new.mailbox_id);
END;--> statement-breakpoint
INSERT INTO `message_fts` (subject, snippet, body, from_text, to_text, message_id, mailbox_id)
  SELECT subject, snippet, coalesce(body_text, ''), coalesce(from_name, '') || ' ' || from_addr, coalesce(to_text, ''), id, mailbox_id FROM `message`;
