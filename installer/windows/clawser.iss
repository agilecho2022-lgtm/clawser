#define AppName "Clawser"
#define AppVersion "2026.3.12"
#define PayloadDir "..\..\dist-installer\Clawser"

[Setup]
AppId={{6F1E23B5-4D43-47B1-9C4F-7635B4B8C8EF}
AppName={#AppName}
AppVersion={#AppVersion}
DefaultDirName={autopf}\Clawser
DefaultGroupName=Clawser
DisableProgramGroupPage=yes
OutputBaseFilename=clawser-windows-x64-setup
OutputDir=..\..\dist-installer
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Clawser Tray"; Filename: "{app}\tray\clawser-tray-windows-amd64.exe"
Name: "{group}\Chrome Extension Install Guide"; Filename: "{app}\chrome-extension-install.html"

[Run]
Filename: "{app}\tray\clawser-tray-windows-amd64.exe"; Description: "Start Clawser Tray"; Flags: nowait postinstall skipifsilent
Filename: "{app}\chrome-extension-install.html"; Description: "Open Chrome extension install guide"; Flags: shellexec nowait postinstall skipifsilent
