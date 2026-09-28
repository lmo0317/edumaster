using EduMaster.Core;

namespace EduMaster.Core.Tests;

public sealed class ScientificVisualsTests
{
    [Fact]
    public void CreatesNerveDrawingFromExplicitFourPointCoordinates()
    {
        var drawing=ScientificVisuals.TryCreateNervePositionDrawing("[그림] d₁=0cm, d₂=2cm, d₃=5cm, d₄=8cm. d₃에 자극한다.");

        Assert.NotNull(drawing);
        Assert.Contains(drawing.Elements,e=>e.Type=="text"&&e.Text.Contains("d4 8cm"));
        Assert.Contains(drawing.Elements,e=>e.Type=="arrow");
        Assert.Equal(3,drawing.Elements.Count(e=>e.Type=="text"&&new[]{"ⓐ","ⓑ","ⓒ"}.Contains(e.Text)));
    }

    [Fact]
    public void DoesNotInventDrawingWhenCoordinatesAreMissing()
    {
        Assert.Null(ScientificVisuals.TryCreateNervePositionDrawing("그림은 d₁~d₄를 나타낸다."));
    }

    [Fact]
    public void AutomaticSceneFitPreservesRelativeGeometryLabelsAndBeakerLevel()
    {
        var original=new ProblemDrawing("신경 배치",1000,300,"좌표 범위 초과",[
            new("arrow",[-20,50,1100,50],"",24,false,"none"),
            new("circle",[400,50,30],"",24,false,"none"),
            new("beaker",[700,100,180,100,.55],"",24,false,"gray"),
            new("text",[1050,260],"d₄ 7cm",24,false,"none")]);
        var fixedScene=ScientificVisuals.FitToCanvas(original);
        var line=fixedScene.Elements[0].Coordinates;var circle=fixedScene.Elements[1].Coordinates;
        Assert.Equal((400d+20)/1120,(circle[0]-line[0])/(line[2]-line[0]),8);
        Assert.Equal(.55,fixedScene.Elements[2].Coordinates[4]);
        Assert.Equal("d₄ 7cm",fixedScene.Elements[3].Text);
        var json=System.Text.Json.JsonSerializer.SerializeToNode(new[]{fixedScene},new System.Text.Json.JsonSerializerOptions{PropertyNamingPolicy=System.Text.Json.JsonNamingPolicy.CamelCase});
        Assert.Single(ScientificVisuals.ParseDrawings(json));
    }

    [Fact]
    public void ExtremeCoordinatesAreNotSilentlyClippedOrReducedToUnreadableSize()
    {
        var scene=new ProblemDrawing("잘못된 배치",1000,300,"",[new("line",[0,0,100000,200],"",24,false,"none")]);
        Assert.Throws<InvalidDataException>(()=>ScientificVisuals.FitToCanvas(scene));
    }

    [Fact]
    public void FitDoesNotChangeAlreadyValidScene()
    {
        var scene=new ProblemDrawing("정상 배치",1000,300,"",[new("line",[100,100,700,200],"",24,false,"none")]);
        Assert.Same(scene,ScientificVisuals.FitToCanvas(scene));
    }

    [Theory]
    [InlineData("신경 | Ⅰ d₁ | Ⅱ d₂ | Ⅲ d₃ | Ⅳ d₄\nA | -80 | 0 | ? | -70")]
    [InlineData("| 신경 | Ⅰ | Ⅱ | Ⅲ | Ⅳ |\n| A | -80 | 0 | ? | -70 |")]
    public void SourceContradictoryTableTriggersRereadBeforeAnyGeneration(string body)
    {
        var source=new ProblemSolutionMaterial(body,"②","A에서 Ⅱ와 Ⅳ의 막전위는 모두 0mV이다.",["지점 매칭","속도 계산","시간 추론"],[]);
        var error=Assert.Throws<InvalidDataException>(()=>source.WithVerifiedLogic());
        Assert.True(error.Data.Contains("TeacherMethodReread"));
        Assert.Contains("Ⅳ",error.Message);Assert.Contains("-70mV",error.Message);Assert.Contains("0mV",error.Message);
    }

    [Fact]
    public void SourceLiteralReviewDoesNotCompareBareAnswerNumberToStatementCombination()
    {
        var source=new ProblemSolutionMaterial("ㄱ. t는 5ms이다.\nㄴ. 시냅스가 있다.\nㄷ. 탈분극이다.","②","ㄱ. t는 5ms이다. (X)\nㄴ. 시냅스가 있다. (O)\nㄷ. 탈분극이다. (X)",["표 비교"],[]);
        Assert.Equal(source,source.WithVerifiedLogic());
    }
}
