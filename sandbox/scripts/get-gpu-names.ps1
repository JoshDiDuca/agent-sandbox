#Requires -Version 5.1
# Prints the name of every display adapter, one per line (guest/toolchains/native/mesa.ts: is there a real GPU?).
$ErrorActionPreference = 'Stop'

(Get-CimInstance Win32_VideoController).Name
