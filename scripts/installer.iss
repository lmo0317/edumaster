[Setup]
AppId={{37AECC7B-A882-47A4-8E6F-B5D4C5EE00F1}
AppName=EduMaster
AppVersion=0.6.0
AppPublisher=EduMaster
DefaultDirName={localappdata}\Programs\EduMaster
DefaultGroupName=EduMaster
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\artifacts\installer
OutputBaseFilename=EduMaster-MVP-Setup
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\EduMaster.App.exe
CloseApplications=yes

[Files]
Source: "..\artifacts\release\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\tools\cache\MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall

[Icons]
Name: "{group}\EduMaster"; Filename: "{app}\EduMaster.App.exe"
Name: "{userdesktop}\EduMaster"; Filename: "{app}\EduMaster.App.exe"

[Run]
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Preparing Microsoft WebView2 Runtime..."; Flags: runhidden waituntilterminated
Filename: "{app}\EduMaster.App.exe"; Description: "Open EduMaster"; Flags: nowait postinstall skipifsilent
