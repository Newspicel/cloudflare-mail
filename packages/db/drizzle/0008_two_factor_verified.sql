-- better-auth's two-factor plugin (1.6.20) writes a `verified` flag on the
-- two_factor row. Schema generated via `@better-auth/cli generate` includes it;
-- without the column, /api/auth/two-factor/enable 500s on insert.

ALTER TABLE `two_factor` ADD `verified` integer DEFAULT true;
