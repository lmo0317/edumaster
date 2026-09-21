using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace EduMaster.Web;

public sealed record SavedReport(string Id,string Title,DateTime CreatedAt,long Size);

public sealed class ReportArchive(string directory,string stylePath)
{
    private readonly SemaphoreSlim gate=new(1);
    private static readonly JsonSerializerOptions JsonOptions=new(JsonSerializerDefaults.Web){WriteIndented=true};
    private static readonly Regex IdPattern=new("^[a-f0-9]{32}$",RegexOptions.Compiled);
    private static readonly string[] BrowserPaths=[
        @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        "/home/lmo0317/apps/edumaster/tools/chrome-headless-shell-linux64/chrome-headless-shell",
        "/snap/bin/chromium","/usr/bin/chromium","/usr/bin/google-chrome"
    ];

    public async Task<SavedReport> SaveAsync(string? title,string? reportHtml,CancellationToken token)
    {
        var html=(reportHtml??"").Trim();
        if(html.Length<100||html.Length>18*1024*1024||!html.StartsWith("<article",StringComparison.OrdinalIgnoreCase)||!html.Contains("report-print",StringComparison.Ordinal))
            throw new ArgumentException("저장할 전체 보고서 내용을 확인해 주세요.");
        if(Regex.IsMatch(html,@"<\s*script\b|\bon\w+\s*=|javascript\s*:",RegexOptions.IgnoreCase))
            throw new ArgumentException("보고서에 저장할 수 없는 실행 코드가 포함되어 있습니다.");
        var displayTitle=NormalizeTitle(title);
        var browser=BrowserPaths.FirstOrDefault(File.Exists)??throw new InvalidOperationException("PDF 저장에 필요한 Chromium 또는 Microsoft Edge를 찾지 못했습니다.");
        Directory.CreateDirectory(directory);
        await gate.WaitAsync(token);
        var id=Guid.NewGuid().ToString("N");var work=Path.Combine(directory,".work-"+id);Directory.CreateDirectory(work);
        try{
            var css=await File.ReadAllTextAsync(stylePath,token);
            var source=Path.Combine(work,"report.html");var output=Path.Combine(work,"report.pdf");var profile=Path.Combine(work,"browser-profile");
            var document="<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\"><title>"
                +System.Net.WebUtility.HtmlEncode(displayTitle)+"</title><style>"+css
                +"\nbody{background:#fff!important;margin:0;padding:0;color:#17243a}.report-print{display:block!important;padding:0}.report-print[hidden]{display:block!important}@page{size:A4;margin:15mm}"
                +"</style></head><body class=\"printing-report\">"+html+"</body></html>";
            await File.WriteAllTextAsync(source,document,new UTF8Encoding(false),token);
            var start=new ProcessStartInfo(browser){UseShellExecute=false,CreateNoWindow=true,RedirectStandardError=true,RedirectStandardOutput=true};
            start.ArgumentList.Add("--headless=new");start.ArgumentList.Add("--disable-gpu");start.ArgumentList.Add("--no-pdf-header-footer");
            if(!OperatingSystem.IsWindows())start.ArgumentList.Add("--no-sandbox");
            start.ArgumentList.Add("--run-all-compositor-stages-before-draw");start.ArgumentList.Add("--virtual-time-budget=5000");
            start.ArgumentList.Add("--user-data-dir="+profile);start.ArgumentList.Add("--print-to-pdf="+output);start.ArgumentList.Add(new Uri(source).AbsoluteUri);
            using var process=Process.Start(start)??throw new InvalidOperationException("PDF 저장 프로세스를 시작하지 못했습니다.");
            using var timeout=CancellationTokenSource.CreateLinkedTokenSource(token);timeout.CancelAfter(TimeSpan.FromSeconds(90));
            try{await process.WaitForExitAsync(timeout.Token);}catch(OperationCanceledException){try{process.Kill(true);}catch{}throw new InvalidOperationException("PDF 생성 시간이 초과됐습니다. 잠시 후 다시 저장해 주세요.");}
            if(process.ExitCode!=0||!File.Exists(output)||new FileInfo(output).Length<1000){var error=await process.StandardError.ReadToEndAsync(token);throw new InvalidOperationException("PDF를 생성하지 못했습니다. "+error.Trim());}
            var finalPdf=Path.Combine(directory,id+".pdf");File.Move(output,finalPdf);
            var saved=new SavedReport(id,displayTitle,DateTime.UtcNow,new FileInfo(finalPdf).Length);
            await File.WriteAllTextAsync(Path.Combine(directory,id+".json"),JsonSerializer.Serialize(saved,JsonOptions),new UTF8Encoding(false),token);
            return saved;
        }finally{
            try{if(Directory.Exists(work))Directory.Delete(work,true);}catch{}
            gate.Release();
        }
    }

    public SavedReport[] List()=>Directory.Exists(directory)
        ?Directory.EnumerateFiles(directory,"*.json").Select(Read).Where(x=>x is not null&&File.Exists(PdfPath(x.Id))).Cast<SavedReport>().OrderByDescending(x=>x.CreatedAt).ToArray()
        :[];

    public string? GetPdfPath(string id)=>IdPattern.IsMatch(id)&&File.Exists(PdfPath(id))?PdfPath(id):null;

    private string PdfPath(string id)=>Path.Combine(directory,id+".pdf");
    private static SavedReport? Read(string path){try{return JsonSerializer.Deserialize<SavedReport>(File.ReadAllText(path),JsonOptions);}catch{return null;}}
    private static string NormalizeTitle(string? title)
    {
        var value=Regex.Replace((title??"").Trim(),@"[\x00-\x1f<>:\""/\\|?*]+"," ");value=Regex.Replace(value,@"\s+"," ").Trim();
        if(value.Length==0)value="EduMaster 단계별 문제 생성 보고서";return value.Length<=100?value:value[..100];
    }
}
