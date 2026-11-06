ALTER TABLE `message` ADD `auto_reply` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `thread` ADD `subject` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `message` SET `auto_reply` = 1
WHERE `direction` = 'in' AND (
  ltrim(`subject`) LIKE 'Automatic reply%'
  OR ltrim(`subject`) LIKE 'Auto-reply%'
  OR ltrim(`subject`) LIKE 'Autoreply%'
  OR ltrim(`subject`) LIKE 'Out of Office%'
  OR ltrim(`subject`) LIKE 'Abwesenheitsnotiz%'
  OR ltrim(`subject`) LIKE 'Automatische Antwort%'
  OR ltrim(`subject`) LIKE 'Réponse automatique%'
  OR ltrim(`subject`) LIKE 'Respuesta automática%'
  OR ltrim(`subject`) LIKE 'Risposta automatica%'
  OR ltrim(`subject`) LIKE 'Automatisch antwoord%'
);--> statement-breakpoint
UPDATE `thread` SET `subject` = coalesce((
  SELECT trim(m.`subject`) FROM `message` m
  WHERE m.`thread_id` = `thread`.`id` AND m.`auto_reply` = 0 AND trim(m.`subject`) <> ''
  ORDER BY coalesce(m.`sent_at`, m.`received_at`, m.`created_at`), m.`created_at`
  LIMIT 1
), '');
