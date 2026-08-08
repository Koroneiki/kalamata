CREATE TABLE `library` (
	`app_id` integer PRIMARY KEY NOT NULL,
	`install_path` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `library_app_id_valid` CHECK(`app_id` > 0 AND `app_id` <= 4294967295)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_install_path_unique` ON `library` (`install_path`);
--> statement-breakpoint
CREATE TABLE `manifest_files` (
	`depot_id` integer NOT NULL,
	`manifest_id` text NOT NULL,
	`relative_path` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`depot_id`, `manifest_id`),
	CONSTRAINT `manifest_files_depot_id_valid` CHECK(`depot_id` > 0 AND `depot_id` <= 4294967295),
	CONSTRAINT `manifest_files_manifest_id_valid` CHECK(`manifest_id` <> '' AND `manifest_id` NOT GLOB '*[^0-9]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `manifest_files_relative_path_unique` ON `manifest_files` (`relative_path`);
--> statement-breakpoint
CREATE TABLE `depot_keys` (
	`depot_id` integer PRIMARY KEY NOT NULL,
	`decryption_key` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `depot_keys_depot_id_valid` CHECK(`depot_id` > 0 AND `depot_id` <= 4294967295)
);
--> statement-breakpoint
CREATE TABLE `library_depot_installs` (
	`app_id` integer NOT NULL,
	`depot_id` integer NOT NULL,
	`installed_manifest_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `depot_id`),
	FOREIGN KEY (`app_id`) REFERENCES `library`(`app_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depot_id`,`installed_manifest_id`) REFERENCES `manifest_files`(`depot_id`,`manifest_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `library_depot_installs_depot_id_valid` CHECK(`depot_id` > 0 AND `depot_id` <= 4294967295),
	CONSTRAINT `library_depot_installs_manifest_id_valid` CHECK(`installed_manifest_id` <> '' AND `installed_manifest_id` NOT GLOB '*[^0-9]*')
);
