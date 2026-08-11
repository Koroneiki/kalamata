PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_library_depot_installs` (
	`app_id` integer NOT NULL,
	`depot_id` integer NOT NULL,
	`installed_manifest_id` text NOT NULL,
	`mount_index` integer NOT NULL,
	`owner_app_id` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `depot_id`),
	FOREIGN KEY (`app_id`) REFERENCES `library`(`app_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "library_depot_installs_depot_id_valid" CHECK("depot_id" > 0 AND "depot_id" <= 4294967295),
	CONSTRAINT "library_depot_installs_owner_app_id_valid" CHECK("owner_app_id" IS NULL OR ("owner_app_id" > 0 AND "owner_app_id" <= 4294967295)),
	CONSTRAINT "library_depot_installs_mount_index_valid" CHECK("mount_index" >= 0),
	CONSTRAINT "library_depot_installs_manifest_id_valid" CHECK("installed_manifest_id" <> '' AND "installed_manifest_id" NOT GLOB '*[^0-9]*')
);
--> statement-breakpoint
INSERT INTO `__new_library_depot_installs`("app_id", "depot_id", "installed_manifest_id", "mount_index", "owner_app_id", "updated_at") SELECT "app_id", "depot_id", "installed_manifest_id", ROW_NUMBER() OVER (PARTITION BY "app_id" ORDER BY "depot_id") - 1, NULL, "updated_at" FROM `library_depot_installs`;--> statement-breakpoint
DROP TABLE `library_depot_installs`;--> statement-breakpoint
ALTER TABLE `__new_library_depot_installs` RENAME TO `library_depot_installs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `library_depot_installs_mount_index_unique` ON `library_depot_installs` (`app_id`,`mount_index`);
