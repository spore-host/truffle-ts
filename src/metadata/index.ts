// Barrel for the static hardware catalogs (processors, GPUs, network, sizes).
// A direct port of the Go tool's pkg/metadata. Populated in issue #2; kept as a
// standalone entry point so consumers can import just the catalogs via the
// package's "./metadata" subpath export without pulling in the find engine.
export {};
