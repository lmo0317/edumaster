using System.IO;
using System.Diagnostics;
using System.Net.Http;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using EduMaster.Core;
namespace EduMaster.App;

public partial class MainWindow : Window
{
    internal StateStore Store { get; set; }
    internal SampleResult? Result { get; private set; }
    internal bool IsBusy { get; private set; }
    internal Exception? LastGenerationError { get; private set; }
    internal LocalGemmaGenerator Generator { get; set; } = new(new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(300) });
    private string DirectoryPath => Path.GetDirectoryName(Store.FilePath)!;
    private ImportedSource? _source;
    private string? _readMethod;
    private CancellationTokenSource? _cancel;
    private Guid _draftId = Guid.NewGuid();
    private int _variation;
    private bool _ready, _dirty, _storageHealthy = true;
    public MainWindow()
    {
        Store = new(ArgumentValue("--data-dir") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "EduMaster"));
        InitializeComponent();
        Loaded += async (_, _) =>
        {
            await RestoreAsync(); _ready = true; UpdateAiNotice();
            if (Environment.GetCommandLineArgs().Contains("--ui-smoke"))
                await NativeUiSmoke.RunAsync(this, ArgumentValue("--evidence-dir") ?? Path.GetFullPath("artifacts/evidence"));
            else if (Environment.GetCommandLineArgs().Contains("--local-smoke"))
                await NativeUiSmoke.RunLocalAsync(this, ArgumentValue("--evidence-dir") ?? Path.GetFullPath("artifacts/evidence/local-gemma"));
            else if (ArgumentValue("--import-file") is { } path) await ImportFileAsync(path);
        };
        Closing += (_, e) =>
        {
            if (IsBusy) { e.Cancel = true; StatusText.Text = "처리 중입니다. ‘취소’를 누르거나 완료 후 창을 닫아 주세요."; }
            else if (_dirty && !Environment.GetCommandLineArgs().Contains("--ui-smoke"))
                e.Cancel = MessageBox.Show(this, "저장하지 않은 변경 내용이 있습니다. 저장하지 않고 닫을까요?", "변경 내용 확인", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes;
        };
    }
    private static string? ArgumentValue(string key)
    { var args = Environment.GetCommandLineArgs(); var i = Array.IndexOf(args, key); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }
    internal ProblemDraft ReadForm() => new()
    {
        Id = _draftId, Source = _source, ReadMethod = _readMethod, FromSolution = MaterialKindInput.SelectedIndex == 1, Title = TitleInput.Text.Trim(), Body = BodyInput.Text.Trim(), Answer = AnswerInput.Text.Trim(), Explanation = ExplanationInput.Text.Trim(),
        Steps = [StepOneInput.Text.Trim(), StepTwoInput.Text.Trim(), StepThreeInput.Text.Trim()]
    };
    internal void LoadExample(ProblemDraft draft)
    {
        var ready = _ready; _ready = false; _draftId = draft.Id; _source = draft.Source; _readMethod = draft.ReadMethod;
        TitleInput.Text = draft.Title; BodyInput.Text = draft.Body; AnswerInput.Text = draft.Answer; ExplanationInput.Text = draft.Explanation;
        MaterialKindInput.SelectedIndex = draft.FromSolution ? 1 : 0;
        GenerateButton.Content=draft.FromSolution?"풀이로 문제 생성  →":"변형 문제 생성  →";
        StepOneInput.Text = draft.Steps[0]; StepTwoInput.Text = draft.Steps[1]; StepThreeInput.Text = draft.Steps[2];
        FileNameText.Text = _source is null ? "파일을 여기로 끌어 놓아도 됩니다" : $"{_source.Name} · {_source.Length / 1024.0:0.#} KB";
        BodyLabel.Text = _source?.IsAttachment == true ? "로컬 인식 본문 (수식·표·그림 정보를 확인하고 수정해 주세요)" : "문제 본문 (수정 가능 · 직접 붙여 넣기도 가능)";
        OpenSourceButton.IsEnabled = _source is not null;
        SourceImage.Source = null; SourceImage.Visibility = Visibility.Collapsed;
        if (_source?.MimeType.StartsWith("image/") == true)
        {
            try
            {
                var image = new BitmapImage(); image.BeginInit(); image.CacheOption = BitmapCacheOption.OnLoad; image.DecodePixelWidth = 800;
                image.UriSource = new Uri(FileImport.SourcePath(_source, DirectoryPath)); image.EndInit(); image.Freeze();
                SourceImage.Source = image; SourceImage.Visibility = Visibility.Visible;
            }
            catch (Exception) { FileNameText.Text += " · 미리보기 불가 (다른 이미지로 다시 선택해 주세요)"; }
        }
        Result = null; ShowResult(); _variation = 0; _ready = ready; _dirty = true;
        EmptyHint.Text = "내 파일을 선택하거나 본문을 넣고 ‘변형 문제 생성’을 눌러 주세요.";
        StatusText.Text = "입력 준비 완료 · 로컬 Gemma 4 12B로 생성합니다. API 키가 필요하지 않습니다.";
    }
    internal async Task RestoreAsync()
    {
        try
        {
            var state = await Store.LoadAsync();
            if (state is null) { LoadExample(new()); _dirty = false; return; }
            LoadExample(state.Draft); Result = state.Result; _variation = state.Variation; ShowResult(); _dirty = false;
            StatusText.Text = $"마지막 저장 내용을 복구했습니다 · {state.SavedAt.LocalDateTime:MM/dd HH:mm}";
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Text.Json.JsonException or ArgumentException)
        { _storageHealthy = false; StatusText.Text = "저장 자료 읽기 실패 · 원본 보호를 위해 저장을 중지했습니다. 저장 폴더의 workspace.json을 확인해 주세요."; }
    }
    private void UpdateAiNotice()
    {
        try
        {
            var settings = new AiSettingsStore(DirectoryPath).Load();
            _ = LocalGemmaGenerator.Endpoint(settings.Endpoint);
            AiNotice.Text = "로컬 Gemma 4 12B · API 키 없이 현재 PC에서 생성합니다. 사진·PDF는 Gemma에 원본 이미지도 전달합니다. 인식 본문과 결과를 확인해 주세요. 교사 확인 전 초안입니다.";
        }
        catch (Exception) { AiNotice.Text = "로컬 AI 설정을 읽지 못했습니다. ‘AI 설정’에서 서버 주소를 다시 저장해 주세요."; }
    }
    private void SettingsClick(object sender, RoutedEventArgs e)
    { if (!IsBusy) OpenAiSettings(); }
    private bool OpenAiSettings()
    {
        var saved = new AiSettingsWindow(new(DirectoryPath)) { Owner = this }.ShowDialog() == true;
        UpdateAiNotice(); return saved;
    }
    internal void ShowFeedback(string title, string message, bool busy = false, bool needsSettings = false)
    {
        EmptyResult.Visibility = Visibility.Visible; ResultScroll.Visibility = Visibility.Collapsed;
        FeedbackTitle.Text = title; EmptyHint.Text = message; FeedbackIcon.Text = busy ? "↻" : "!";
        FeedbackIcon.Foreground = busy ? System.Windows.Media.Brushes.Teal : System.Windows.Media.Brushes.DarkOrange;
        GenerationProgress.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
        InlineSettingsButton.Visibility = needsSettings ? Visibility.Visible : Visibility.Collapsed;
        RetryGenerationButton.Visibility = !busy && !needsSettings ? Visibility.Visible : Visibility.Collapsed;
        ResultBadge.Text = busy ? "생성 중" : needsSettings ? "AI 연결 필요" : "생성 중단";
        StatusText.Text = message;
    }
    private async void ImportClick(object sender, RoutedEventArgs e)
    {
        if (IsBusy) return;
        var dialog = new Microsoft.Win32.OpenFileDialog { Title = "변형할 샘플 문제 파일 선택", Filter = "지원 파일|*.pdf;*.png;*.jpg;*.jpeg;*.txt;*.docx|모든 파일|*.*", Multiselect = false };
        if (dialog.ShowDialog(this) == true) await ImportFileAsync(dialog.FileName);
    }
    internal async Task ImportFileAsync(string path)
    {
        if (IsBusy) return;
        var previous=ReadForm();var previousResult=Result;
        using var cancel=new CancellationTokenSource(TimeSpan.FromSeconds(120));_cancel=cancel;SetBusy(true);
        var watch=Stopwatch.StartNew();var timer=new DispatcherTimer{Interval=TimeSpan.FromSeconds(1)};
        timer.Tick+=(_,_)=>StatusText.Text=EmptyHint.Text=$"파일 읽는 중 · {watch.Elapsed.TotalSeconds:0}초 경과 · 취소 가능";
        timer.Start();ShowFeedback("파일을 읽고 있습니다","파일을 준비한 뒤 원본 미리보기를 먼저 표시합니다.",busy:true);
        try
        {
            var draft = (await FileImport.ImportAsync(path, DirectoryPath,cancel.Token)) with{FromSolution=previous.FromSolution};
            LoadExample(draft);
            if (draft.Source is { IsAttachment: true } source)
            {
                StatusText.Text = "로컬 Qwen3-VL 이미지 인식로 파일을 로컬에서 읽는 중…";
                ShowFeedback("원본 자료를 읽고 있습니다","로컬 Qwen3-VL이 본문·표·수식을 읽습니다. 취소할 수 있습니다.",busy:true);
                draft = draft with { Body = await LocalDocumentReader.ReadAsync(source, DirectoryPath,cancel.Token), ReadMethod = "로컬 Qwen3-VL 이미지 인식" };
            }
            LoadExample(draft); await SaveCurrentAsync();
            if (draft.Source?.IsAttachment == true) StatusText.Text = "파일을 로컬에서 읽고 저장했습니다. 수식·표·그림의 조건을 본문에서 확인·수정한 뒤 ‘변형 문제 생성’을 눌러 주세요.";
        }
        catch(OperationCanceledException){LoadExample(previous);Result=previousResult;ShowFeedback("파일 읽기를 중단했습니다","취소했거나 읽기 시간이 2분을 넘었습니다. 이전 입력은 유지됩니다.");}
        catch (Exception e) when (e is ArgumentException or IOException or InvalidDataException or UnauthorizedAccessException or System.Xml.XmlException or InvalidOperationException or System.Runtime.InteropServices.COMException or HttpRequestException)
        { LoadExample(previous);Result=previousResult;ShowFeedback("파일을 읽지 못했습니다", e.Message + " · 이전 입력은 유지됩니다. 문제 본문을 직접 붙여 넣을 수도 있습니다."); }
        finally { timer.Stop();_cancel=null;SetBusy(false); }
    }
    private void FileDragOver(object sender, DragEventArgs e)
    { e.Effects = !IsBusy && e.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None; e.Handled = true; }
    private async void FileDrop(object sender, DragEventArgs e)
    {
        e.Handled = true; if (IsBusy || e.Data.GetData(DataFormats.FileDrop) is not string[] files) return;
        if (files.Length != 1) { StatusText.Text = "먼저 파일 하나를 넣어 주세요."; return; } await ImportFileAsync(files[0]);
    }
    private async void OpenSourceClick(object sender, RoutedEventArgs e)
    {
        if (_source is null || IsBusy) return;
        try { await FileImport.ReadSourceAsync(_source, DirectoryPath); Process.Start(new ProcessStartInfo(FileImport.SourcePath(_source, DirectoryPath)) { UseShellExecute = true }); }
        catch (Exception) { StatusText.Text = "원본을 열지 못했습니다. 파일을 다시 선택하거나 기본 연결 프로그램을 확인해 주세요."; }
    }
    private void ExampleOneClick(object sender, RoutedEventArgs e) { if (!IsBusy) LoadExample(SampleProblems.Nitrogen()); }
    private void ExampleTwoClick(object sender, RoutedEventArgs e) { if (!IsBusy) LoadExample(SampleProblems.Magnesium()); }
    private void ResetClick(object sender, RoutedEventArgs e) { if (!IsBusy) LoadExample(new()); }
    private void InputChanged(object sender, TextChangedEventArgs e)
    {
        if (!_ready) return; _dirty = true;
        if (Result is not null) { Result = null; ShowResult(); EmptyHint.Text = "입력이 바뀌었습니다. 변형 문제를 다시 생성해 주세요."; }
        StatusText.Text = "입력 변경 · 저장되지 않은 변경 내용";
    }
    private void MaterialKindChanged(object sender,SelectionChangedEventArgs e)
    {
        if(!_ready)return;_dirty=true;Result=null;ShowResult();
        GenerateButton.Content=MaterialKindInput.SelectedIndex==1?"풀이로 문제 생성  →":"변형 문제 생성  →";
        StatusText.Text="입력 모드를 변경했습니다. 선택한 자료를 기준으로 새로 생성해 주세요.";
    }
    private void SetBusy(bool busy)
    {
        IsBusy = busy; GenerateButton.IsEnabled = SaveButton.IsEnabled = ImportButton.IsEnabled = SettingsButton.IsEnabled = DemoButton.IsEnabled = !busy;
        OpenSourceButton.IsEnabled = !busy && _source is not null;
        TitleInput.IsEnabled = BodyInput.IsEnabled = AnswerInput.IsEnabled = ExplanationInput.IsEnabled = !busy;
        MaterialKindInput.IsEnabled = !busy;
        StepOneInput.IsEnabled = StepTwoInput.IsEnabled = StepThreeInput.IsEnabled = !busy;
        CopyButton.IsEnabled = PdfButton.IsEnabled = !busy && Result is not null;
        CancelButton.Visibility = busy && _cancel is not null ? Visibility.Visible : Visibility.Collapsed;
        GenerateButton.Content = busy && _cancel is not null ? "처리 중…" : MaterialKindInput.SelectedIndex==1?"풀이로 문제 생성  →":"변형 문제 생성  →";
    }
    private void CancelClick(object sender, RoutedEventArgs e) => _cancel?.Cancel();
    private async void GenerateClick(object sender, RoutedEventArgs e) => await GenerateRealAsync();
    internal async Task GenerateRealAsync()
    {
        LastGenerationError = null;
        if (IsBusy) return;
        ProblemDraft draft; AiSettings settings;
        try
        {
            draft = ReadForm(); draft.Validate(); settings = new AiSettingsStore(DirectoryPath).Load();
            _ = LocalGemmaGenerator.Endpoint(settings.Endpoint);
            if (draft.Source is { IsAttachment: true } source && draft.ReadMethod is null)
            {
                SetBusy(true); ShowFeedback("기준 자료를 로컬에서 읽고 있습니다", "로컬 Qwen3-VL 이미지 인식로 문제 글자를 인식합니다.", busy: true);
                try { var recognized=await LocalDocumentReader.ReadAsync(source, DirectoryPath); LoadExample(draft with { Body = recognized + (string.IsNullOrWhiteSpace(draft.Body)?"":"\n\n[기존 입력]\n"+draft.Body), ReadMethod = "로컬 Qwen3-VL 이미지 인식" }); await SaveCurrentAsync(); }
                finally { SetBusy(false); }
                ShowFeedback("인식한 본문을 확인해 주세요", "수식·표·그림 정보가 맞는지 왼쪽 본문에서 확인·수정한 뒤 다시 생성해 주세요. 로컬 OCR은 화학 수식을 잘못 읽을 수 있습니다."); return;
            }
        }
        catch (ArgumentException e) { ShowFeedback("기준 문제를 확인해 주세요", e.Message); return; }
        catch (Exception) { ShowFeedback("로컬 설정 또는 파일 읽기 실패", "AI 설정의 서버 주소와 파일을 확인해 주세요. 문제 본문을 직접 붙여 넣을 수도 있습니다.", needsSettings: true); return; }
        using var cancel = new CancellationTokenSource(); _cancel = cancel; SetBusy(true);
        var watch = Stopwatch.StartNew(); var phase = "입력 확인";
        var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        timer.Tick += (_, _) => { StatusText.Text = EmptyHint.Text = $"{phase}\n{watch.Elapsed.TotalSeconds:0}초 경과 · 취소 가능"; };
        Result = null; ShowResult(); ShowFeedback("변형 문제를 만들고 있습니다", "입력 확인 · 0초 경과", busy: true); timer.Start();
        try
        {
            var progress = new Progress<string>(s => { if (!timer.IsEnabled) return; phase = s; StatusText.Text = EmptyHint.Text = $"{s}\n{watch.Elapsed.TotalSeconds:0}초 경과 · 취소 가능"; });
            var images=draft.Source is {IsAttachment:true} attachment?await LocalDocumentReader.RenderAsync(attachment,DirectoryPath,cancel.Token):null;
            Result = await Generator.GenerateAsync(draft, settings.Endpoint, progress, cancel.Token, images);
            timer.Stop(); ShowResult(); _dirty = true; await SaveCurrentAsync();
        }
        catch (OperationCanceledException) { timer.Stop(); ShowFeedback(cancel.IsCancellationRequested ? "생성을 취소했습니다" : "AI 응답 시간이 초과됐습니다", cancel.IsCancellationRequested ? "생성 취소 · 입력은 유지됩니다." : "로컬 Gemma 응답 시간 초과 (300초) · 입력을 줄이거나 서버 상태를 확인해 주세요."); }
        catch (Exception e) when (e is ArgumentException or IOException or InvalidDataException or InvalidOperationException or UnsupportedProblemException)
        { timer.Stop(); ShowFeedback("변형 문제를 생성하지 못했습니다", e.Message); }
        catch (HttpRequestException) { timer.Stop(); ShowFeedback("로컬 Gemma에 연결하지 못했습니다", "Gemma 4 12B 서버 실행 상태를 확인해 주세요. 기본 주소는 127.0.0.1:8092입니다. 입력은 유지됩니다.", needsSettings: true); }
        catch (Exception error) { LastGenerationError = error; timer.Stop(); ShowFeedback("로컬 AI 생성 처리에 실패했습니다", "AI 설정과 서버 상태를 확인해 주세요. 입력은 유지됩니다.", needsSettings: true); }
        finally { timer.Stop(); _cancel = null; SetBusy(false); }
    }
    private async void DemoClick(object sender, RoutedEventArgs e) => await GenerateSampleAsync();
    internal async Task GenerateSampleAsync()
    {
        if (IsBusy) return; SetBusy(true); StatusText.Text = "고정 예시 시연 준비 중…";
        try
        {
            await Task.Yield(); Result = SampleProblems.Generate(ReadForm(), _variation++); ShowResult(); _dirty = true; await SaveCurrentAsync();
        }
        catch (ArgumentException e) { StatusText.Text = e.Message; }
        finally { SetBusy(false); }
    }
    private async void SaveClick(object sender, RoutedEventArgs e)
    { if (IsBusy) return; SetBusy(true); try { await SaveCurrentAsync(); } finally { SetBusy(false); } }
    internal async Task SaveCurrentAsync()
    {
        if (!_storageHealthy) { StatusText.Text = "저장 자료 읽기 실패로 저장이 중지되어 있습니다. 원본 파일을 복구한 뒤 다시 실행해 주세요."; return; }
        try
        {
            await Store.SaveAsync(new(ReadForm(), Result, _variation, DateTimeOffset.Now)); _dirty = false;
            StatusText.Text = $"{(Result is null ? "기준 자료" : Result.GenerationNotice + " 결과")} 저장 완료 · {DateTime.Now:HH:mm:ss} · 재실행 시 복구됩니다";
        }
        catch (ArgumentException e) { StatusText.Text = e.Message; }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        { StatusText.Text = "저장 실패 · 화면 내용은 유지됩니다. 저장 공간·폴더 권한을 확인하고 ‘저장’을 다시 눌러 주세요."; }
    }
    internal void ShowResult()
    {
        GenerationProgress.Visibility = InlineSettingsButton.Visibility = RetryGenerationButton.Visibility = Visibility.Collapsed;
        FeedbackTitle.Text = "새 문제가 여기에 나타납니다"; FeedbackIcon.Text = "✧"; FeedbackIcon.Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(162,207,197));
        EmptyResult.Visibility = Result is null ? Visibility.Visible : Visibility.Collapsed;
        ResultScroll.Visibility = Result is null ? Visibility.Collapsed : Visibility.Visible;
        CopyButton.IsEnabled = PdfButton.IsEnabled = Result is not null && !IsBusy;
        ResultBadge.Text = Result is null ? "생성 대기" : (Result.Model == "" ? "고정 예시 시연" : "AI 초안");
        if (Result is null) return;
        ResultTitle.Text = Result.Title; ResultBody.Text = Result.Body; ResultAnswer.Text = Result.Answer;
        ResultExplanation.Text = Result.Explanation; ChangeText.Text = Result.GenerationNotice + "\n" + Result.ChangeSummary + (Result.Model == "" ? "" : "\n" + Result.Model + " · " + Result.UsageSummary);
        SourceProblemPanel.Visibility = Result.SourceProblem == "" ? Visibility.Collapsed : Visibility.Visible; SourceProblemText.Text = Result.SourceProblem;
        ResultFigures.Children.Clear();
        foreach(var figure in Result.Figures){
            var image=new BitmapImage();image.BeginInit();image.CacheOption=BitmapCacheOption.OnLoad;image.StreamSource=new MemoryStream(Convert.FromBase64String(figure.DataUrl[(figure.DataUrl.IndexOf(',')+1)..]));image.EndInit();image.Freeze();
            ResultFigures.Children.Add(new TextBlock{Text=figure.Caption,TextWrapping=TextWrapping.Wrap,Margin=new Thickness(0,8,0,4)});
            ResultFigures.Children.Add(new Image{Source=image,MaxHeight=700,Stretch=System.Windows.Media.Stretch.Uniform});
        }
        ChangeText.Text+="\n"+Result.VisualVerification;
        ChoicesList.ItemsSource = Result.Choices.Select((s, i) => $"{new[] { "①", "②", "③", "④", "⑤" }[i]}  {s}");
        ResultSteps.Text = string.Join("\n", Result.Steps.Select((s, i) => $"{i + 1}. {s}")); ResultScroll.ScrollToTop();
    }
    private void CopyClick(object sender, RoutedEventArgs e)
    {
        if (Result is null) return;
        try
        {
            Clipboard.SetText($"{Result.GenerationNotice}\n\n{Result.Title}\n{Result.Body}\n\n{string.Join("\n", Result.Choices.Select((s,i) => $"{i+1}. {s}"))}\n\n정답: {Result.Answer}\n{Result.Explanation}");
            StatusText.Text = Result.Figures.Length>0?"본문을 복사했습니다. 그림을 포함하려면 PDF 저장을 사용해 주세요.":"문제·정답·해설을 클립보드에 복사했습니다.";
        }
        catch (System.Runtime.InteropServices.COMException) { StatusText.Text = "클립보드를 사용하지 못했습니다. 잠시 후 다시 눌러 주세요."; }
    }
    private void PdfClick(object sender, RoutedEventArgs e)
    { if (Result is not null) new PdfPreviewWindow(Result, DirectoryPath) { Owner = this }.Show(); }
}
