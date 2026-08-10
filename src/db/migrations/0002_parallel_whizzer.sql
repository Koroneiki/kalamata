CREATE TABLE `__library_depot_installs_backup` AS SELECT * FROM `library_depot_installs`;--> statement-breakpoint
CREATE TABLE `__new_library` (
	`app_id` integer PRIMARY KEY NOT NULL,
	`install_path` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "library_app_id_valid" CHECK("app_id" > 0 AND "app_id" <= 4294967295)
);
--> statement-breakpoint
INSERT INTO `__new_library`("app_id", "install_path", "created_at") SELECT "app_id", "install_path", "created_at" FROM `library`;--> statement-breakpoint
DROP TABLE `library`;--> statement-breakpoint
ALTER TABLE `__new_library` RENAME TO `library`;--> statement-breakpoint
INSERT INTO `library_depot_installs` SELECT * FROM `__library_depot_installs_backup`;--> statement-breakpoint
DROP TABLE `__library_depot_installs_backup`;--> statement-breakpoint
CREATE UNIQUE INDEX `library_install_path_unique` ON `library` (`install_path`);--> statement-breakpoint
CREATE TABLE `library_depot_selections` (
	`app_id` integer NOT NULL,
	`depot_id` integer NOT NULL,
	PRIMARY KEY(`app_id`, `depot_id`),
	FOREIGN KEY (`app_id`) REFERENCES `library`(`app_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "library_depot_selections_app_id_valid" CHECK("library_depot_selections"."app_id" > 0 AND "library_depot_selections"."app_id" <= 4294967295),
	CONSTRAINT "library_depot_selections_depot_id_valid" CHECK("library_depot_selections"."depot_id" > 0 AND "library_depot_selections"."depot_id" <= 4294967295)
);
