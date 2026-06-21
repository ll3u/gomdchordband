package main

// Version is set at build time via -ldflags
var Version = "dev"

func GetVersion() string {
	return Version
}
