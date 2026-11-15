{
  description = "Perplexity Pro MCP server";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      packages.${system}.default = pkgs.buildNpmPackage {
        pname = "perplexity-pro-mcp";
        version = "1.0.1";
        src = ./.;
        npmDepsHash = "sha256-JjhTzw2PCmCfZbHi1CrlREs+QrlyYGHVk9ZNc8juhMg=";
        postInstall = ''
          ln -sf $out/bin/perplexity-pro-mcp $out/bin/perplexity-mcp
        '';
      };
    };
}