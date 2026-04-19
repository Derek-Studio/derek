{
  inputs = {
    nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/*";

    snowfall-lib = {
      url = "https://flakehub.com/f/snowfallorg/lib/3.0.3";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    pre-commit-hooks = {
      url = "github:cachix/pre-commit-hooks.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    inputs:
    let
      lib = inputs.snowfall-lib.mkLib {
        inherit inputs;
        src = ./nix;

        snowfall = {
          namespace = "snowflake";
        };
      };
    in
    lib.mkFlake {
      inherit inputs;
      src = ./nix;

      outputs-builder = channels: {
        formatter = channels.nixpkgs.nixpkgs-fmt;

        checks.pre-commit-check = inputs.pre-commit-hooks.lib.${channels.nixpkgs.system}.run {
          src = ./.;
          hooks = {
            nixfmt = {
              enable = true;
              entry = "${channels.nixpkgs.nixfmt}/bin/nixfmt";
              extraPackages = [ channels.nixpkgs.nixfmt ];
            };
          };
        };
      };
    };
}
