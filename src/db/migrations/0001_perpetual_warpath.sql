CREATE TABLE `__new_library_depot_installs` (
	`app_id` integer NOT NULL,
	`depot_id` integer NOT NULL,
	`installed_manifest_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `depot_id`),
	FOREIGN KEY (`app_id`) REFERENCES `library`(`app_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "library_depot_installs_depot_id_valid" CHECK(`depot_id` > 0 AND `depot_id` <= 4294967295),
	CONSTRAINT "library_depot_installs_manifest_id_valid" CHECK(`installed_manifest_id` <> '' AND `installed_manifest_id` NOT GLOB '*[^0-9]*')
);
--> statement-breakpoint
INSERT INTO `__new_library_depot_installs` (`app_id`, `depot_id`, `installed_manifest_id`, `updated_at`) SELECT `app_id`, `depot_id`, `installed_manifest_id`, `updated_at` FROM `library_depot_installs`;
--> statement-breakpoint
DROP TABLE `library_depot_installs`;
--> statement-breakpoint
ALTER TABLE `__new_library_depot_installs` RENAME TO `library_depot_installs`;
