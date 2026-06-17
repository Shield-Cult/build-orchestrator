# To run - `nix develop`
{ 
  description = "Set up dev shell";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
  }:
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = nixpkgs.legacyPackages.${system};
      in rec {
        devShells.default = pkgs.mkShellNoCC {
          # Which packages need to be loaded into this shell
          packages = with pkgs; [
            nodejs_22 # includes npm
          ];

          shellHook = ''
            echo "Starting Dev Shell - to leave, simply run `exit`"
            
            # Debug info
            echo "  node $(node -v)  npm $(npm -v)"
            
            # Open Editors
            codium .
            cursor . --classic
          '';
        };
      }
    );
}
