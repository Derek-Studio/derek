{
  lib,
  inputs,
  namespace,
  pkgs,
  mkShell,
  ...
}:

mkShell {
  # Create your shell
  packages = with pkgs; [
    nodejs_20
    pnpm
    git
  ];
}
