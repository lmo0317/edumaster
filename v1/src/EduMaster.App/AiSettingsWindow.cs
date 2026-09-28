using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using EduMaster.Core;
namespace EduMaster.App;

internal sealed record AiSettings(string Endpoint);
internal sealed class AiSettingsStore(string directory)
{
    internal string FilePath => Path.Combine(directory,"local-ai.json");
    internal AiSettings Load()
    {
        var settings=File.Exists(FilePath)?JsonSerializer.Deserialize<AiSettings>(File.ReadAllText(FilePath))??throw new InvalidDataException("로컬 AI 설정이 비어 있습니다."):new(LocalGemmaGenerator.DefaultEndpoint);
        return LocalGemmaGenerator.Endpoint(settings.Endpoint).AbsoluteUri=="http://127.0.0.1:8089/v1/"?new(LocalGemmaGenerator.DefaultEndpoint):settings;
    }
    internal void Save(AiSettings settings)
    {
        _=LocalGemmaGenerator.Endpoint(settings.Endpoint); Directory.CreateDirectory(directory);
        var temporary=FilePath+"."+Guid.NewGuid().ToString("N")+".tmp";
        try{File.WriteAllText(temporary,JsonSerializer.Serialize(settings));File.Move(temporary,FilePath,true);}
        finally{if(File.Exists(temporary))File.Delete(temporary);}
    }
}
internal sealed class AiSettingsWindow:Window
{
    internal AiSettingsWindow(AiSettingsStore store)
    {
        Title="로컬 AI 설정 · Gemma 4 12B"; Width=600; Height=470; ResizeMode=ResizeMode.NoResize;
        WindowStartupLocation=WindowStartupLocation.CenterOwner; FontFamily=new("맑은 고딕"); Background=System.Windows.Media.Brushes.White;
        var panel=new StackPanel{Margin=new(28)};Content=panel;
        panel.Children.Add(new TextBlock{Text="로컬 Gemma 4 12B",FontSize=24,FontWeight=FontWeights.Bold,Margin=new(0,0,0,12)});
        panel.Children.Add(new TextBlock{Text="API 키 없이 현재 PC의 설치된 모델을 사용합니다.\nGemma가 원본 이미지와 본문을 함께 받아 생성합니다. 사진·PDF의 인식 본문과 연결 관계를 확인해 주세요.",TextWrapping=TextWrapping.Wrap,Margin=new(0,0,0,20)});
        panel.Children.Add(new TextBlock{Text="로컬 서버 주소",Margin=new(0,0,0,6)});
        var address=new TextBox{Padding=new(10),Margin=new(0,0,0,16)};panel.Children.Add(address);
        var info=new TextBlock{Text="기본 주소의 Gemma 4 12B에 자동 연결합니다. 모델이 다르면 생성하지 않습니다.",TextWrapping=TextWrapping.Wrap,Margin=new(0,0,0,20)};panel.Children.Add(info);
        var buttons=new WrapPanel();panel.Children.Add(buttons);
        var check=new Button{Content="연결 확인",Padding=new(18,9,18,9),Margin=new(0,0,10,0)};buttons.Children.Add(check);
        var save=new Button{Content="설정 저장",Padding=new(18,9,18,9)};buttons.Children.Add(save);
        try{address.Text=store.Load().Endpoint;}catch(Exception){address.Text=LocalGemmaGenerator.DefaultEndpoint;info.Text="설정을 읽지 못했습니다. 기본 주소로 다시 저장해 주세요.";}
        check.Click+=async(_,_)=>
        {
            check.IsEnabled=false;info.Text="Gemma 4 12B 연결 확인 중…";
            try{using var http=new HttpClient(new HttpClientHandler{AllowAutoRedirect=false}){Timeout=TimeSpan.FromSeconds(5)};var model=await new LocalGemmaGenerator(http).ProbeAsync(address.Text,requireVision:true);info.Text=$"연결 완료 · {model.Name} · 문맥 {model.ContextSize:N0} 토큰\nAPI 키 불필요 · 본문은 현재 PC에서 처리합니다.";}
            catch(Exception){info.Text="Gemma 4 12B에 연결하지 못했습니다. 로컬 서버 실행 상태와 주소를 확인해 주세요.";}
            finally{check.IsEnabled=true;}
        };
        save.Click+=(_,_)=>{try{store.Save(new(LocalGemmaGenerator.Endpoint(address.Text).AbsoluteUri));DialogResult=true;}catch(Exception){info.Text="현재 PC의 올바른 로컬 주소를 입력해 주세요. 예: http://127.0.0.1:8092/v1/";}};
    }
}
