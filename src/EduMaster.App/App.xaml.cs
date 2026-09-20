using System.Configuration;
using System.Data;
using System.Windows;

namespace EduMaster.App;

/// <summary>
/// Interaction logic for App.xaml
/// </summary>
public partial class App : Application
{
    private Mutex? _instance;
    protected override void OnStartup(StartupEventArgs e)
    {
        var index = Array.IndexOf(e.Args, "--data-dir");
        var path = index >= 0 && index + 1 < e.Args.Length ? System.IO.Path.GetFullPath(e.Args[index + 1])
            : System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "EduMaster");
        var identity = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(path.ToUpperInvariant())));
        _instance = new Mutex(true, "Local\\EduMaster-" + identity, out var created);
        if (!created)
        {
            MessageBox.Show("EduMaster가 이미 실행 중입니다. 작업 표시줄에서 열린 창을 선택해 주세요.", "EduMaster");
            Shutdown(); return;
        }
        base.OnStartup(e);
    }
    protected override void OnExit(ExitEventArgs e) { _instance?.Dispose(); base.OnExit(e); }
}

