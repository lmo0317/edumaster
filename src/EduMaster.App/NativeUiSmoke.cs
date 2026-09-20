using System.IO;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using EduMaster.Core;
namespace EduMaster.App;

internal static class NativeUiSmoke
{
    private const string OwnProblem="탄산칼슘 10 g을 완전히 분해한다. CaCO₃ → CaO + CO₂, CaCO₃ = 100 g/mol일 때 발생하는 CO₂의 몰수는?";
    internal static async Task RunAsync(MainWindow window,string directory)
    {
        Directory.CreateDirectory(directory);var checks=new List<string>();var exit=0;var initialRestoredId=window.Result?.Id;
        try
        {
            var fixture=Path.Combine(directory,"own-problem.txt");await File.WriteAllTextAsync(fixture,OwnProblem);await window.ImportFileAsync(fixture);
            Require(window.BodyInput.Text==OwnProblem&&window.AnswerInput.Text==""&&window.Result is null,"file-input-without-answer");
            var settings=new AiSettingsStore(Path.GetDirectoryName(window.Store.FilePath)!);settings.Save(new(LocalGemmaGenerator.DefaultEndpoint));
            Require(settings.Load().Endpoint==LocalGemmaGenerator.DefaultEndpoint,"local-settings-no-api-key");
            var dialog=new AiSettingsWindow(settings){Owner=window};dialog.Show();await Task.Delay(100);Capture(dialog,Path.Combine(directory,"local-settings.png"));dialog.Close();
            using(var http=new HttpClient(new ModelHandler()))
            {
                window.Generator=new(http);window.GenerateButton.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));await WaitIdle(window);
                Require(window.ResultAnswer.Text=="③ 0.2 mol"&&window.Result?.Model=="Gemma 4 12B","local-provider-button-result");
                Require(window.Result!.GenerationNotice.Contains("로컬")&&window.Result.SourceProblem.Contains(OwnProblem),"source-and-local-draft-label");
                Require(window.StatusText.Text.Contains("저장 완료"),"automatic-save");
                var store=window.Store;var id=window.Result.Id;var restored=new MainWindow{Store=store};await restored.RestoreAsync();
                Require(restored.Result?.Id==id&&restored.ReadForm().Body==OwnProblem,"restart-restores-input-result");
                window.AiNotice.Text="자동 UI 테스트 · 로컬 모델 HTTP 응답 대역 사용 · 실제 생성 평가 화면이 아닙니다.";Capture(window,Path.Combine(directory,"local-contract-test.png"));
                window.Width=1000;window.Height=700;await Task.Delay(100);Require(window.GenerateButton.ActualWidth>100&&window.ResultScroll.ActualHeight>200,"small-window-visible");window.Width=1320;window.Height=900;
                var preview=new PdfPreviewWindow(window.Result,Path.GetDirectoryName(store.FilePath)!){Owner=window};preview.Show();
                try{await preview.Ready.WaitAsync(TimeSpan.FromSeconds(30));await preview.ExportAsync(Path.Combine(directory,"local-problem.pdf"));Require(new FileInfo(Path.Combine(directory,"local-problem.pdf")).Length>1000,"pdf-export");}finally{preview.Close();}
                window.BodyInput.Text="화학 문제가 없는 개발 문서";Require(window.Result is null&&!window.PdfButton.IsEnabled,"changed-input-invalidates-result");
                window.GenerateButton.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));await WaitIdle(window);Require(window.FeedbackTitle.Text.Contains("생성하지 못")&&window.RetryGenerationButton.Visibility==Visibility.Visible,"unsupported-visible-not-fake-result");
            }
            window.LoadExample(SampleProblems.Nitrogen());
            using(var http=new HttpClient(new ModelHandler(wrongModel:true)))
            {window.Generator=new(http);window.GenerateButton.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));await WaitIdle(window);Require(window.Result is null&&window.EmptyHint.Text.Contains("로드되지"),"wrong-model-not-substituted");}
            using(var http=new HttpClient(new ModelHandler(cancelOnly:true)))
            {
                window.Generator=new(http);window.GenerateButton.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));await Task.Delay(100);
                Require(window.IsBusy&&window.GenerationProgress.Visibility==Visibility.Visible&&window.CancelButton.Visibility==Visibility.Visible,"progress-and-cancel-visible");
                window.CancelButton.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));await WaitIdle(window);Require(window.Result is null&&window.EmptyHint.Text.Contains("취소"),"cancel-preserves-input");
            }
            window.DemoButton.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));await WaitIdle(window);Require(window.ResultAnswer.Text=="③ 4 mol","explicit-demo-still-separate");
            var original=window.Store;var blocked=Path.Combine(directory,"blocked");await File.WriteAllTextAsync(blocked,"not-a-directory");window.Store=new(blocked);
            window.SaveButton.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));await WaitIdle(window);Require(window.StatusText.Text.Contains("저장 실패")&&window.Result is not null,"failed-save-preserves-visible-result");window.Store=original;
        }
        catch(Exception e){exit=1;checks.Add("FAIL: "+e);}
        await File.WriteAllTextAsync(Path.Combine(directory,"ui-smoke.json"),JsonSerializer.Serialize(new{passed=exit==0,initialRestoredId,checks},new JsonSerializerOptions{WriteIndented=true}));Application.Current.Shutdown(exit);
        void Require(bool condition,string name){if(!condition)throw new InvalidOperationException(name);checks.Add("PASS: "+name);}
    }
    internal static async Task RunLocalAsync(MainWindow window,string directory)
    {
        Directory.CreateDirectory(directory);var checks=new List<string>();var exit=0;
        try
        {
            var fixture=Path.Combine(directory,"real-local-input.txt");await File.WriteAllTextAsync(fixture,OwnProblem);await window.ImportFileAsync(fixture);
            window.Generator=new(new HttpClient(new RecordingHandler(directory)){Timeout=TimeSpan.FromSeconds(300)});
            await window.GenerateRealAsync();if(window.LastGenerationError is not null)throw window.LastGenerationError;Require(window.Result is not null,"actual-gemma-text-generation");
            Capture(window,Path.Combine(directory,"actual-local-text-result.png"));
            await File.WriteAllTextAsync(Path.Combine(directory,"actual-local-text-result.json"),JsonSerializer.Serialize(window.Result,new JsonSerializerOptions{WriteIndented=true}));
            var image=Path.GetFullPath("docs/참고자료/샘플자료/04_분자구조_문제.png");await window.ImportFileAsync(image);
            Require(window.ReadForm().ReadMethod=="Windows OCR"&&window.BodyInput.Text.Length>100,"actual-local-image-ocr");
            Capture(window,Path.Combine(directory,"actual-local-image-ocr.png"));
            await File.WriteAllTextAsync(Path.Combine(directory,"image-ocr.txt"),window.BodyInput.Text);
            var pdf=await FileImport.ImportAsync(Path.GetFullPath("docs/참고자료/프로그램.pdf"),Path.GetDirectoryName(window.Store.FilePath)!);
            var text=await LocalDocumentReader.ReadAsync(pdf.Source!,Path.GetDirectoryName(window.Store.FilePath)!);
            Require(text.Contains("페이지 5")&&text.Length>1000,"actual-local-five-page-pdf-ocr");
            await File.WriteAllTextAsync(Path.Combine(directory,"pdf-ocr.txt"),text);
            await window.ImportFileAsync(fixture);await window.GenerateRealAsync();Require(window.Result is not null,"actual-gemma-second-variation");
            Capture(window,Path.Combine(directory,"actual-local-final.png"));
        }
        catch(Exception e){exit=1;checks.Add("FAIL: "+e);}
        await File.WriteAllTextAsync(Path.Combine(directory,"local-smoke.json"),JsonSerializer.Serialize(new{passed=exit==0,checks},new JsonSerializerOptions{WriteIndented=true}));Application.Current.Shutdown(exit);
        void Require(bool condition,string name){if(!condition)throw new InvalidOperationException(name+" · "+window.StatusText.Text);checks.Add("PASS: "+name);}
    }
    private sealed class ModelHandler(bool wrongModel=false,bool cancelOnly=false):HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token)
        {
            if(request.Method==HttpMethod.Get)return Json(new{data=new[]{new{id=wrongModel?"qwen-7b":"gemma-4-12b-it-qat-q4_0.gguf"}}});
            if(cancelOnly)await Task.Delay(Timeout.Infinite,token);
            using var requestJson=JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));using var input=JsonDocument.Parse(requestJson.RootElement.GetProperty("messages")[1].GetProperty("content").GetString()!);
            var source=input.RootElement.GetProperty("body").GetString()!;
            var variant=new{status=source.Contains("CaCO₃")?"ready":"unsupported",message="화학 문제가 없습니다.",sourceProblem=source,sourceLocation="문항 1",title="탄산칼슘 열분해 · 테스트 응답",
                body="탄산칼슘 20 g을 완전히 분해한다. CaCO₃ → CaO + CO₂, CaCO₃ = 100 g/mol일 때 발생하는 CO₂의 몰수는?",choices=new[]{"0.05 mol","0.1 mol","0.2 mol","0.4 mol","1 mol"},answerIndex=2,
                answerText="0.2 mol",explanation="20/100=0.2 mol이며 계수비 1:1에 따라 CO₂도 0.2 mol 발생한다.",steps=new[]{"몰질량 확인","20/100 계산","계수비 1:1 적용"},changeSummary="10 g → 20 g"};
            return Json(new{choices=new[]{new{finish_reason="stop",message=new{content=JsonSerializer.Serialize(variant)}}},usage=new{total_tokens=321}});
        }
        private static HttpResponseMessage Json(object value)=>new(HttpStatusCode.OK){Content=new StringContent(JsonSerializer.Serialize(value),System.Text.Encoding.UTF8,"application/json")};
    }
    private sealed class RecordingHandler(string directory):DelegatingHandler(new HttpClientHandler{AllowAutoRedirect=false})
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token)
        {
            var response=await base.SendAsync(request,token);
            if(request.Method==HttpMethod.Post)await File.WriteAllTextAsync(Path.Combine(directory,"actual-response.json"),await response.Content.ReadAsStringAsync(token),token);
            return response;
        }
    }
    private static async Task WaitIdle(MainWindow window){var deadline=DateTime.UtcNow.AddSeconds(10);do{await Task.Delay(25);if(DateTime.UtcNow>deadline)throw new TimeoutException();}while(window.IsBusy);}
    private static void Capture(Window window,string file){window.UpdateLayout();var bitmap=new RenderTargetBitmap((int)window.ActualWidth,(int)window.ActualHeight,96,96,PixelFormats.Pbgra32);bitmap.Render(window);var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));using var output=File.Create(file);encoder.Save(output);}
}
