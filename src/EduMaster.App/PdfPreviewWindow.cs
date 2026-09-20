using System.IO;
using System.Net;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using EduMaster.Core;

namespace EduMaster.App;

internal sealed class PdfPreviewWindow : Window
{
    private readonly WebView2 _web = new();
    private readonly Button _save = new() { Content = "PDF 저장", Padding = new(20, 8, 20, 8), IsEnabled = false };
    private readonly TextBlock _status = new() { Text = "로컬 미리보기 준비 중…", Margin = new(18, 10, 10, 10) };
    private readonly TaskCompletionSource _loaded = new(TaskCreationOptions.RunContinuationsAsynchronously);
    internal Task Ready => _loaded.Task;
    internal PdfPreviewWindow(SampleResult result, string dataDirectory)
    {
        Title = "문제 PDF 미리보기 · 교사 확인 전"; Width = 850; Height = 900; FontFamily = new("맑은 고딕");
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        var dock = new DockPanel(); var bar = new DockPanel { Margin = new(10) }; bar.Children.Add(_save); bar.Children.Add(_status);
        DockPanel.SetDock(bar, Dock.Top); dock.Children.Add(bar); dock.Children.Add(_web); Content = dock;
        _save.Click += async (_, _) =>
        {
            var dialog = new Microsoft.Win32.SaveFileDialog { Filter = "PDF 문서|*.pdf", FileName = "EduMaster_샘플문제.pdf" };
            if (dialog.ShowDialog(this) != true) return; _save.IsEnabled = false;
            try { await ExportAsync(dialog.FileName); _status.Text = "PDF 저장 완료"; }
            catch (Exception) { _status.Text = "PDF 저장 실패 · 저장 위치와 파일 사용 여부를 확인해 주세요."; }
            finally { _save.IsEnabled = true; }
        };
        Loaded += async (_, _) =>
        {
            try
            {
                var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(dataDirectory, "WebView2"));
                await _web.EnsureCoreWebView2Async(env); var core = _web.CoreWebView2;
                core.Settings.AreHostObjectsAllowed = false; core.Settings.IsWebMessageEnabled = false;
                core.Settings.AreDevToolsEnabled = false; core.Settings.AreDefaultContextMenusEnabled = false;
                core.NewWindowRequested += (_, e) => e.Handled = true; core.DownloadStarting += (_, e) => e.Cancel = true;
                core.NavigationStarting += (_, e) => { if (!e.Uri.StartsWith("about:blank", StringComparison.OrdinalIgnoreCase) && !e.Uri.StartsWith("data:text/html", StringComparison.OrdinalIgnoreCase)) e.Cancel = true; };
                core.NavigationCompleted += async (_, e) =>
                {
                    if (!e.IsSuccess) { _loaded.TrySetException(new IOException("미리보기 표시 실패: " + e.WebErrorStatus)); return; }
                    try { await core.ExecuteScriptAsync("document.fonts.ready.then(() => true)"); _save.IsEnabled = true; _status.Text = result.GenerationNotice; _loaded.TrySetResult(); }
                    catch (Exception error) { _loaded.TrySetException(error); }
                };
                core.NavigateToString(BuildHtml(result));
            }
            catch (Exception e) { _status.Text = "미리보기 실패 · WebView2 런타임을 확인해 주세요."; _loaded.TrySetException(e); }
        };
        Closed += (_, _) => _web.Dispose();
    }
    internal async Task ExportAsync(string path)
    {
        await Ready.WaitAsync(TimeSpan.FromSeconds(30)); var settings = _web.CoreWebView2.Environment.CreatePrintSettings();
        settings.PageWidth = 8.2677; settings.PageHeight = 11.6929;
        settings.MarginTop = settings.MarginBottom = settings.MarginLeft = settings.MarginRight = 0.4;
        settings.ShouldPrintBackgrounds = true; settings.ShouldPrintHeaderAndFooter = false;
        if (!await _web.CoreWebView2.PrintToPdfAsync(path, settings)) throw new IOException("PDF 생성 실패");
    }
    private static string BuildHtml(SampleResult r)
    {
        static string E(string s) => WebUtility.HtmlEncode(s).Replace("\n", "<br>");
        return $$"""
        <!doctype html><html lang="ko"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; script-src 'none'">
        <style>@page{size:A4;margin:12mm}*{box-sizing:border-box}body{font-family:'Malgun Gothic',sans-serif;color:#17243a;padding:24px;font-size:14px;line-height:1.8}header{border-bottom:2px solid #087f70;padding-bottom:12px;color:#087f70;font-weight:bold}.notice{background:#fff7e3;padding:10px;font-size:11px;color:#886014}h1{font-size:23px}h2{font-size:17px;margin-top:24px}.choice{padding:4px 12px;background:#f4f6fa;margin:4px 0;break-inside:avoid}.answer{padding:12px;background:#edf8f4}p{orphans:3;widows:3}</style>
        <header>EduMaster · 화학 문제 스튜디오</header><p class="notice">{{E(r.GenerationNotice)}} · 정답과 해설 포함</p><h1>{{E(r.Title)}}</h1><p>{{E(r.Body)}}</p>
        {{string.Join("",r.Figures.Select(f=>$"<figure><figcaption>{E(f.Caption)}</figcaption><img alt='기준 그림' style='max-width:100%;max-height:650px' src='{WebUtility.HtmlEncode(f.DataUrl)}'></figure>"))}}
        {{string.Join("", r.Choices.Select((s, i) => $"<div class='choice'>{i + 1}. {E(s)}</div>"))}}
        <h2>정답 · 검토 전</h2><div class="answer">{{E(r.Answer)}}</div><h2>해설</h2><p>{{E(r.Explanation)}}</p><h2>풀이 흐름</h2><p>{{string.Join("<br>", r.Steps.Select((s, i) => $"{i + 1}. {E(s)}"))}}</p></html>
        """;
    }
}
