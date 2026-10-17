{
  description = "Perplexity Pro MCP server";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      packages.${system}.default = pkgs.writeShellScriptBin "perplexity-mcp" ''
        exec ${pkgs.nodejs}/bin/node ${./.}/dist/index.js "$@"
      '';
    };
}
