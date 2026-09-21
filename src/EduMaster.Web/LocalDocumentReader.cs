using System.Diagnostics;
using EduMaster.Core;

namespace EduMaster.App;

// Cross-platform web reader. Images are kept byte-for-byte so the selected
// cloud/local vision model sees the original pixels. PDF pages are rendered by
// Poppler, which is installed on the always-on Linux host.
internal static class LocalDocumentReader
{
    internal static async Task<string> ReadAsync(ImportedSource source,string directory,CancellationToken token=default)
    {
        using var client=new HttpClient(new HttpClientHandler{AllowAutoRedirect=false}){Timeout=TimeSpan.FromSeconds(300)};
        var reader=new LocalVisionReader(client);var texts=new List<string>();
        foreach(var page in await RenderAsync(source,directory,token))texts.Add($"[페이지 {page.Page}]\n"+await reader.ReadAsync(page.Bytes,page.MimeType,token));
        var text=string.Join("\n\n",texts).Trim();
        if(text.Length<8)throw new InvalidOperationException("사진에서 글자를 충분히 읽지 못했습니다. 더 선명한 파일을 선택하거나 문제 본문을 직접 입력해 주세요.");
        if(text.Length>12000)throw new ArgumentException("인식 본문이 12,000자를 넘었습니다. 문제 부분만 따로 넣어 주세요.");
        return text;
    }

    internal static async Task<VisualPage[]> RenderAsync(ImportedSource source,string directory,CancellationToken token=default)
    {
        var sourcePath=FileImport.SourcePath(source,directory);
        if(source.MimeType is "image/png" or "image/jpeg")return [new(await FileImport.ReadSourceAsync(source,directory,token),source.MimeType,1)];
        if(source.MimeType!="application/pdf")return [];
        var work=Path.Combine(directory,"pdf-render-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(work);
        try{
            var pages=await PageCountAsync(sourcePath,token);if(pages>5)throw new ArgumentException("PDF는 5페이지까지 지원합니다. 문제 한 개만 별도 저장해 주세요.");
            var prefix=Path.Combine(work,"page");
            await RunAsync("pdftoppm",["-f","1","-l",Math.Min(5,pages).ToString(),"-r","180","-png",sourcePath,prefix],token);
            var files=Directory.EnumerateFiles(work,"page-*.png").OrderBy(path=>path,StringComparer.Ordinal).ToArray();
            if(files.Length==0)throw new InvalidOperationException("PDF 페이지를 이미지로 변환하지 못했습니다.");
            var result=new List<VisualPage>();for(var i=0;i<files.Length;i++)result.Add(new(await File.ReadAllBytesAsync(files[i],token),"image/png",i+1));
            if(result.Sum(page=>(long)page.Bytes.Length)>FileImport.MaxBytes)throw new ArgumentException("렌더링 이미지가 10MB를 넘습니다. 문제 한 개만 넣어 주세요.");
            return result.ToArray();
        }finally{try{Directory.Delete(work,true);}catch{}}
    }

    internal static Task<VisualPage[]> MaterialViewsAsync(VisualPage page,CancellationToken token)=>Task.FromResult(new[]{page});

    private static async Task<int> PageCountAsync(string path,CancellationToken token)
    {
        var output=await RunAsync("pdfinfo",[path],token);var line=output.Split('\n').FirstOrDefault(value=>value.StartsWith("Pages:",StringComparison.OrdinalIgnoreCase));
        return line is not null&&int.TryParse(line.Split(':',2)[1].Trim(),out var count)&&count>0?count:throw new InvalidDataException("PDF 페이지 수를 확인하지 못했습니다.");
    }

    private static async Task<string> RunAsync(string file,IEnumerable<string> arguments,CancellationToken token)
    {
        var start=new ProcessStartInfo(file){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};foreach(var value in arguments)start.ArgumentList.Add(value);
        using var process=Process.Start(start)??throw new InvalidOperationException(file+" 실행 파일을 찾지 못했습니다.");
        var stdout=process.StandardOutput.ReadToEndAsync(token);var stderr=process.StandardError.ReadToEndAsync(token);await process.WaitForExitAsync(token);
        if(process.ExitCode!=0)throw new InvalidOperationException("문서 이미지 변환에 실패했습니다. "+(await stderr).Trim());return await stdout;
    }
}
