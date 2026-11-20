// Base64 helpers used by the test database setup (global on Workers and Node 16+).
// Declared here so the package keeps `types: []` and `lib: ["ES2022"]`.
declare function atob(data: string): string;
declare function btoa(data: string): string;
