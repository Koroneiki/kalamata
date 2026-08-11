CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`hide_redistributables` integer NOT NULL,
	`show_windows` integer NOT NULL,
	`show_macos` integer NOT NULL,
	`show_linux` integer NOT NULL,
	CONSTRAINT "settings_singleton" CHECK("settings"."id" = 1)
);
