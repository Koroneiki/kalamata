PRAGMA foreign_keys=OFF;--> statement-breakpoint
-- Invalid legacy keys were unusable; remove them before adding the constraint.
DELETE FROM `depot_keys` WHERE length(`decryption_key`) <> 64 OR `decryption_key` GLOB '*[^0-9A-Fa-f]*';--> statement-breakpoint
CREATE TABLE `__new_depot_keys` (
	`depot_id` integer PRIMARY KEY NOT NULL,
	`decryption_key` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "depot_keys_depot_id_valid" CHECK("depot_id" > 0 AND "depot_id" <= 4294967295),
	CONSTRAINT "depot_keys_decryption_key_valid" CHECK(length("decryption_key") = 64 AND "decryption_key" NOT GLOB '*[^0-9A-Fa-f]*')
);
--> statement-breakpoint
INSERT INTO `__new_depot_keys`("depot_id", "decryption_key", "created_at") SELECT "depot_id", "decryption_key", "created_at" FROM `depot_keys`;--> statement-breakpoint
DROP TABLE `depot_keys`;--> statement-breakpoint
ALTER TABLE `__new_depot_keys` RENAME TO `depot_keys`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
